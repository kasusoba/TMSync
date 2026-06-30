/// <reference types="wxt/vite-builder-env" />

interface ImportMetaEnv {
  readonly WXT_TRAKT_CLIENT_ID: string;
  readonly WXT_TRAKT_CLIENT_SECRET: string;
  /** Discord application clientId for Rich Presence (experimental, optional). */
  readonly WXT_DISCORD_CLIENT_ID: string;
  /** TMDB API key — poster art for Discord RP only (optional; not a tracker). */
  readonly WXT_TMDB_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
