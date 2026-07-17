/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** ApiStack's ApiUrl output, baked in at build time by scripts/write-web-env.ts. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
