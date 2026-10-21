/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** `git describe --tags --long`, set by `pnpm build`; absent in dev. */
    readonly VITE_GIT_VERSION?: string;
}
