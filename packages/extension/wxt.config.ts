import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// Stable identity so the OAuth redirect URI never changes across reloads.
// This is the Chrome Web Store item's OWN public key, so the local unpacked
// build gets the SAME id as the published extension — one redirect URI covers
// dev and prod:
//   Chrome ID  : hkfpacmhbiccimikfleemmhfemdnjfpf
//   Redirect   : https://hkfpacmhbiccimikfleemmhfemdnjfpf.chromiumapp.org/
//   Firefox    : tmsync@onesal.me  (browser.identity.getRedirectURL() derives from it)
// The value below is the PUBLIC key (DER, base64) — safe to commit. The matching
// private key is held by the Chrome Web Store, not us (we upload a zip; the store
// signs it), so there's no .pem to keep.
const CHROME_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnHwVw4cwX6aSFK+k5dw4oSnqAiHJy7skS0+pAeT1L3xv29dVaMnz2ENO0l8pA4vGo4pUd+97SmMFJ6aj2gKj8Uq0Cw5c1Ke1E+vMneV4eFhb3jqlRPIuavihIBlSK27bR/WNm3mIUgeguKcyl7nF6NqWBKei8NcDEfthzZD/9zHwTEE/ep6TsN9E6PhO7DzpXUs8K1qsh/kpa9EL18vgpxzEnA9G6Ma/RVevJFnqPOxpJ79sSmQbk6kaVzlI3VtSr3fzPK/wYsNSGgHRp1Oy5f+x+SJ2f3Omb0LRBdKGnZcRCOBArl5G2xxcHwZln0TAIXHN0tsbMO4SPUdPSZJDawIDAQAB";

// See ../../CLAUDE.md for the settled constraints encoded here.
export default defineConfig({
  srcDir: ".",
  // Dev runner: DON'T auto-launch a throwaway browser+profile. Instead load the
  // dev build into your OWN Edge once (edge://extensions → Developer mode → Load
  // unpacked → .output/chrome-mv3-dev) — then `pnpm dev` just watches + rebuilds
  // and the extension hot-reloads itself in your normal profile: no new window,
  // your Trakt/AniList logins persist. (Content-script/UI edits may still need a
  // page refresh; background/options/popup reload on their own.)
  // Flip `disabled: false` to instead auto-launch a dedicated dev window via the
  // Edge binary below (fresh profile each run).
  webExt: {
    disabled: true,
    binaries: {
      edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    },
  },
  manifest: ({ browser }) => ({
    name: "TMSync",
    description:
      "Passively scrobble what you watch to your trackers (Trakt and AniList so far), on any streaming site.",
    // `identity` for Trakt OAuth; `activeTab` lets the popup read the current
    // tab's URL (on the action click) to offer "enable on this site".
    permissions: ["storage", "alarms", "scripting", "identity", "activeTab"],
    // Specific (non-broad) host access: the Trakt API, the AniList GraphQL
    // endpoint, and the CDN we fetch the recipe list from. Allowed by constraint
    // #5 — what's forbidden is broad `*://*/*` / <all_urls>.
    host_permissions: [
      "https://api.trakt.tv/*",
      // anilist.co for the OAuth token exchange (code → access token); graphql
      // host for the GraphQL API.
      "https://anilist.co/*",
      "https://graphql.anilist.co/*",
      "https://raw.githubusercontent.com/*",
      // E2E only: lets the perf test register the content script on the local
      // fixture server without the popup gesture. Never in a shipped build.
      ...(process.env.E2E ? ["http://localhost/*", "http://127.0.0.1/*"] : []),
    ],
    // Constraint #5: NO broad host_permissions at install. We request per-origin
    // streaming-site access on a user gesture, then registerContentScripts.
    optional_host_permissions: ["*://*/*"],
    // Stable extension identity (so the OAuth redirect URI is fixed).
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "tmsync@onesal.me",
              // Required for new Firefox extensions (mzl.la/firefox-builtin-data-consent).
              // TMSync collects nothing: watch data goes only to the user's OWN tracker
              // accounts (Trakt/AniList) via their APIs, and any backend gets only
              // anonymous recipe data, never watch history (CLAUDE.md constraint #6).
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : { key: CHROME_KEY }),
  }),
  hooks: {
    // Guard for constraint #5. WXT derives broad host access from the content
    // script's `matches` (even under `registration: "runtime"`): on MV3 it adds
    // `host_permissions`, on Firefox MV2 it folds `*://*/*` into required
    // `permissions`. We strip both so NOTHING broad is requested at install, and
    // express it as optional on MV2 so the runtime-grant model holds there too.
    "build:manifestGenerated"(_wxt, manifest) {
      // Settings page reads better full-tab than the cramped embedded dialog
      // Chrome defaults to. WXT generates options_ui itself, so set it here.
      if (manifest.options_ui) manifest.options_ui.open_in_tab = true;

      const BROAD = "*://*/*";
      // MV3: drop broad required host access.
      if (manifest.host_permissions) {
        manifest.host_permissions = manifest.host_permissions.filter((p: string) => p !== BROAD);
        if (manifest.host_permissions.length === 0) {
          manifest.host_permissions = undefined;
        }
      }
      // MV2 folds host perms into required `permissions` — drop broad there too.
      if (manifest.permissions) {
        manifest.permissions = manifest.permissions.filter((p: string) => p !== BROAD);
      }
      // MV2 has no `optional_host_permissions`, and WXT doesn't translate it.
      // Declare the broad host as an OPTIONAL permission so Firefox can grant it
      // at runtime per the same user-gesture model as Chrome.
      if (manifest.manifest_version === 2) {
        manifest.optional_permissions = [
          ...new Set([...(manifest.optional_permissions ?? []), BROAD]),
        ];
      }
    },
  },
  vite: () => ({
    plugins: [tailwindcss(), preact()],
  }),
});
