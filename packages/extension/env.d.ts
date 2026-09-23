/// <reference types="wxt/vite-builder-env" />

interface ImportMetaEnv {
  readonly WXT_TRAKT_CLIENT_ID: string;
  readonly WXT_TRAKT_CLIENT_SECRET: string;
  readonly WXT_MAL_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
