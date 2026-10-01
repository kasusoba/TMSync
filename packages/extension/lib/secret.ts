/**
 * Encryption at rest for OAuth tokens. One AES-GCM key per install, created
 * non-extractable and kept in the extension's IndexedDB, so no script can read
 * the key bytes back out, and a copy of `storage.local` alone (a profile copy, a
 * disk image) holds no usable token. This is defense in depth: code that runs as
 * the extension can still decrypt. Only extension pages and the background may
 * call it: a content script would reach the host page's IndexedDB.
 */

const DB = "tmsync-secrets";
const STORE = "keys";
const KEY_ID = "tokens";

/** A sealed value as it sits in storage. */
export interface Sealed {
  sealed: 1;
  /** Base64 AES-GCM nonce (12 bytes). */
  iv: string;
  /** Base64 ciphertext of the JSON value. */
  data: string;
}

export function isSealed(value: unknown): value is Sealed {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Sealed).sealed === 1 &&
    typeof (value as Sealed).iv === "string" &&
    typeof (value as Sealed).data === "string"
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadOrCreateKey(): Promise<CryptoKey> {
  const db = await openDb();
  try {
    const found = await request<CryptoKey | undefined>(
      db.transaction(STORE).objectStore(STORE).get(KEY_ID),
    );
    if (found) return found;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    // `add`, not `put`: when the popup and the background create a key at the same
    // moment, the second add fails and that side reads the winner.
    try {
      await request(db.transaction(STORE, "readwrite").objectStore(STORE).add(key, KEY_ID));
      return key;
    } catch {
      const winner = await request<CryptoKey | undefined>(
        db.transaction(STORE).objectStore(STORE).get(KEY_ID),
      );
      if (winner) return winner;
      throw new Error("Could not store the token key.");
    }
  } finally {
    db.close();
  }
}

// A cache of a value that IndexedDB holds anyway, not session state (constraint
// #4): a new worker loads it again. A failure is not cached, so the next call tries
// again.
let keyPromise: Promise<CryptoKey> | null = null;
function tokenKey(): Promise<CryptoKey> {
  keyPromise ??= loadOrCreateKey().catch((e) => {
    keyPromise = null;
    throw e;
  });
  return keyPromise;
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Encrypt a JSON value. */
export async function seal(value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(), plain);
  return { sealed: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

/** Decrypt a sealed value. Throws when the key cannot open it (a lost or new key). */
export async function unseal<T>(sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv) },
    await tokenKey(),
    fromBase64(sealed.data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Forget the cached key (tests: a fresh IndexedDB means a fresh key). */
export function resetSecretKeyCache(): void {
  keyPromise = null;
}
