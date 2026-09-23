import type { ParsedMedia } from "@tmsync/shared";
import { browser } from "wxt/browser";
import { simklMatches, simklScrobbleAt } from "../storage";
import { getValidAccessToken, refreshAfterReject } from "./auth";
import { SCROBBLE_LOCK_MS, SIMKL } from "./config";
import type { SimklMatch, SimklMediaObject, SimklScrobbleResponse, SimklSection } from "./types";

export class SimklNotConnectedError extends Error {
  constructor() {
    super("Not connected to Simkl");
    this.name = "SimklNotConnectedError";
  }
}

/** A Simkl response: status, the `error` id of an error body, and the JSON body. */
export interface SimklReply<T> {
  status: number;
  error?: string;
  data?: T;
}

/** The query parameters Simkl asks every request to carry. */
function appParams(): string {
  let version = "0";
  try {
    version = browser.runtime.getManifest().version;
  } catch {
    // no runtime (tests)
  }
  return new URLSearchParams({
    client_id: SIMKL.clientId,
    "app-name": SIMKL.appName,
    "app-version": version,
  }).toString();
}

/**
 * POST to the Simkl API with the user's token. JSON body; no `User-Agent` (a
 * browser can't set it; `app-name` identifies us instead). A 401 retries once with
 * a refreshed token. Never retries anything else: Simkl throttles repeated POSTs.
 */
export async function simklPost<T>(path: string, body: unknown): Promise<SimklReply<T>> {
  const token = await getValidAccessToken();
  if (!token) throw new SimklNotConnectedError();
  const send = (bearer: string) =>
    fetch(`${SIMKL.apiBase}${path}?${appParams()}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
  let res = await send(token);
  if (res.status === 401) {
    const next = await refreshAfterReject(token);
    if (!next) throw new SimklNotConnectedError();
    res = await send(next);
    if (res.status === 401) throw new SimklNotConnectedError();
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  const error =
    !res.ok && data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : undefined;
  return { status: res.status, error, data: res.ok ? (data as T) : undefined };
}

/** The Simkl body key an item goes under. A season means seasoned numbering
 * (`show`); a bare episode means cour numbering (`anime`). Pure. */
export function simklKind(media: ParsedMedia): "movie" | "show" | "anime" {
  if (media.mediaType === "movie") return "movie";
  return media.season !== undefined ? "show" : "anime";
}

/** The ids we send, as strings (Simkl accepts both, echoes strings). For `anime`,
 * only cour ids: a TMDB show id there could match the wrong cour. Pure. */
export function simklIds(media: ParsedMedia, simklId?: number): Record<string, string | number> {
  const ids: Record<string, string | number> = {};
  if (simklId) ids.simkl = simklId;
  const kind = simklKind(media);
  const keys =
    kind === "anime"
      ? (["mal", "anilist"] as const)
      : (["tmdb", "imdb", "tvdb", "mal", "anilist"] as const);
  for (const k of keys) {
    const v = media.ids?.[k];
    if (v !== undefined && v !== "") ids[k] = String(v);
  }
  // No cour id at all: a tmdb id still beats a bare title.
  if (kind === "anime" && Object.keys(ids).length === 0 && media.ids?.tmdb !== undefined) {
    ids.tmdb = String(media.ids.tmdb);
  }
  return ids;
}

/**
 * The cache key for a page item. Per show season, not per show: Simkl files each
 * anime season as its own entry, so AoT S1 and S3 match different items. An
 * `anime` item (no season) keys on its cour id first: a TMDB show id names the
 * whole show, so it would give every cour one key. `perSeason: false` drops the
 * season (the whole show, for what Simkl keeps per show). Pure.
 */
export function simklKey(media: ParsedMedia, perSeason = true): string {
  const kind = simklKind(media);
  const season = kind === "show" && perSeason ? `:s${media.season}` : "";
  const order =
    kind === "anime"
      ? (["mal", "anilist", "tmdb", "imdb", "tvdb"] as const)
      : (["tmdb", "imdb", "tvdb", "mal", "anilist"] as const);
  for (const k of order) {
    const v = media.ids?.[k];
    if (v !== undefined && v !== "") return `${kind}:${k}:${v}${season}`;
  }
  return `${kind}:t:${media.title.trim().toLowerCase()}:${media.year ?? ""}${season}`;
}

/** The media object for a body: title, year and ids (Simkl matches on these). */
function mediaObject(media: ParsedMedia, simklId?: number) {
  return {
    title: media.title,
    ...(media.year ? { year: media.year } : {}),
    ids: simklIds(media, simklId),
  };
}

/**
 * The scrobble body for a page item, or null when an episode is missing (a show
 * needs season + episode, an anime needs the episode). Pure.
 */
export function scrobbleBody(
  media: ParsedMedia,
  progress: number,
  simklId?: number,
): Record<string, unknown> | null {
  const p = Math.round(Math.max(0, Math.min(100, progress)) * 100) / 100;
  const obj = mediaObject(media, simklId);
  switch (simklKind(media)) {
    case "movie":
      return { progress: p, movie: obj };
    case "show":
      if (media.episode === undefined) return null;
      return { progress: p, show: obj, episode: { season: media.season, number: media.episode } };
    case "anime":
      if (media.episode === undefined) return null;
      return { progress: p, anime: obj, episode: { number: media.episode } };
  }
}

/** What a scrobble response says Simkl matched (id, page section, title). Pure. */
export function matchFrom(res: SimklScrobbleResponse | undefined): SimklMatch | null {
  if (!res) return null;
  const pick: [SimklSection, SimklMediaObject | undefined][] = [
    ["movies", res.movie],
    ["anime", res.anime],
    ["tv", res.show],
  ];
  for (const [section, obj] of pick) {
    const id = obj?.ids?.simkl ?? obj?.ids?.simkl_id;
    if (obj && id) return { id, section, title: obj.title ?? "", year: obj.year };
  }
  return null;
}

/** Remember what Simkl matched a page item to. */
export async function saveMatch(media: ParsedMedia, match: SimklMatch): Promise<void> {
  const all = await simklMatches.getValue();
  await simklMatches.setValue({ ...all, [simklKey(media)]: match });
}

/** The cached match for a page item, if a write has told us one. */
export async function getMatch(media: ParsedMedia): Promise<SimklMatch | undefined> {
  return (await simklMatches.getValue())[simklKey(media)];
}

/** The Simkl page for a match (attribution: link wherever Simkl data shows). */
export function matchUrl(m: SimklMatch): string {
  return `https://simkl.com/${m.section}/${m.id}`;
}

/** How long until the 20 s scrobble lock is free (0 = free now). Pure. */
export function lockWait(lastAt: number, now: number): number {
  return Math.max(0, lastAt + SCROBBLE_LOCK_MS - now);
}

/** How long until a scrobble call may go out (0 = now). */
export async function scrobbleLockWait(): Promise<number> {
  return lockWait(await simklScrobbleAt.getValue(), Date.now());
}

/** Ping an extension API this often while waiting. A timer alone does not count
 * as activity, and the browser stops an idle service worker after about 30 s. */
const KEEP_ALIVE_MS = 10_000;

/**
 * Wait out the scrobble lock without the worker being stopped mid-wait (a stop
 * waits up to about 40 s). Each short step calls a cheap extension API, which
 * resets the idle timer. Nothing is kept after the wait (constraint #4).
 */
async function waitAwake(ms: number): Promise<void> {
  const until = Date.now() + ms;
  for (let left = ms; left > 0; left = until - Date.now()) {
    await new Promise((r) => setTimeout(r, Math.min(left, KEEP_ALIVE_MS)));
    try {
      await browser.runtime.getPlatformInfo();
    } catch {
      // no runtime (tests)
    }
  }
}

export type ScrobblePhase = "start" | "pause" | "stop";

/**
 * One scrobble call, stamped as the lock's start before it goes out (so a second
 * caller sees the lock at once). A call that never reached Simkl (offline, or not
 * connected) gives the stamp back, so it does not cost the next call 20 s.
 */
async function lockedPost(
  phase: ScrobblePhase,
  body: Record<string, unknown>,
): Promise<SimklReply<SimklScrobbleResponse>> {
  const before = await simklScrobbleAt.getValue();
  await simklScrobbleAt.setValue(Date.now());
  try {
    return await simklPost<SimklScrobbleResponse>(`/scrobble/${phase}`, body);
  } catch (e) {
    await simklScrobbleAt.setValue(before);
    throw e;
  }
}

/** The outcome of one scrobble call. `skipped` = a start/pause inside the lock. */
export type ScrobbleOutcome =
  | { kind: "ok"; action?: SimklScrobbleResponse["action"]; match: SimklMatch | null }
  | { kind: "skipped" }
  | { kind: "already_recorded" }
  | { kind: "not_found" }
  | { kind: "failed"; status: number; error?: string };

/**
 * Send one scrobble, respecting Simkl's one-call-per-20-s lock:
 *  - start / pause inside the window are dropped (they only update "watching now";
 *    the stop still records the watch).
 *  - stop waits for the window, and waits once more if Simkl still reports the
 *    lock, so the watched write is never lost. The wait (at most about 40 s) runs
 *    inside this one request and keeps the worker awake (`waitAwake`). It is not a
 *    timer kept in the background (constraint #4).
 * The last-call time lives in storage, so every wake of the worker sees it.
 */
export async function scrobble(
  phase: ScrobblePhase,
  body: Record<string, unknown>,
): Promise<ScrobbleOutcome> {
  const wait = lockWait(await simklScrobbleAt.getValue(), Date.now());
  if (wait > 0) {
    if (phase !== "stop") return { kind: "skipped" };
    await waitAwake(wait);
  }
  let res = await lockedPost(phase, body);
  if (res.status === 400 && res.error === "RATE_LIMIT") {
    if (phase !== "stop") return { kind: "skipped" };
    await waitAwake(SCROBBLE_LOCK_MS);
    res = await lockedPost(phase, body);
  }
  // Re-stopping a finished item within an hour: the watch is already recorded.
  if (res.status === 409) return { kind: "already_recorded" };
  if (res.status === 404) return { kind: "not_found" };
  if (res.status < 200 || res.status >= 300) {
    return { kind: "failed", status: res.status, error: res.error };
  }
  return { kind: "ok", action: res.data?.action, match: matchFrom(res.data) };
}
