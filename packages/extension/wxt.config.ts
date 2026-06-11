import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// Stable identity so the OAuth redirect URI never changes across reloads:
//   Chrome ID  : aplaigellojlejhdjkklgihlmbmdaebk
//   Redirect   : https://aplaigellojlejhdjkklgihlmbmdaebk.chromiumapp.org/
//   Firefox    : tmsync@tmsync.app  (browser.identity.getRedirectURL() derives from it)
// The value below is the PUBLIC key (DER, base64) — safe to commit; the private
// .pem stays in .keys/ (gitignored).
const CHROME_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsnTrCTOs9IeUqPjL4Bzed2fMXEWfWzE8jRjLefx0bEyNhtySxrDHm8qZEq6sZ7RjDKVBLmrM5D3IIDm6wQNtC8HucQSow/oN333P5+No8RdXUsJwqN21uMYrr79VwotQp3/61JrtWlbUWFZmjaCuSPQvNFUPvoEYAn6OuK9K2dzYiGjro46KBVeBSbeXgbm+L4Bhv4ilq4wPAbHtfXg/BrA5sbCF/bf3TUJK5LeFoYvF/hJEW2RkkRY5pKXkUB4bNiDXgCTDIPGuw/kSiVtHo8AEKXWVHX27e8XY56PHPEIkMZHdo6GLPp069f7r+eIpeCB0xzbLDC4SX4luC53mUwIDAQAB";

// See ../../CLAUDE.md for the settled constraints encoded here.
export default defineConfig({
  srcDir: ".",
  manifest: ({ browser }) => ({
    name: "TMSync",
    description: "Passively scrobble movies & TV to Trakt on any streaming site.",
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
    // `webNavigation` powers the frame inspector: getAllFrames reveals each
    // frame's REAL committed URL (streaming embeds redirect, e.g. vsrc.su →
    // cloudnestra.com, so the iframe `src` attribute lies). Optional + requested
    // on the "Inspect frames" gesture, so it's not in the install footprint.
    optional_permissions: ["webNavigation"],
    // Stable extension identity (so the OAuth redirect URI is fixed).
    ...(browser === "firefox"
      ? { browser_specific_settings: { gecko: { id: "tmsync@tmsync.app" } } }
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
