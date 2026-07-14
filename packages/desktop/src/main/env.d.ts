interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_ENTERPRISE: string
  readonly OPENCODE_ENTERPRISE_BASE_URL: string
  readonly OPENCODE_ENTERPRISE_MODEL_ID: string
  readonly OPENCODE_ENTERPRISE_MODEL_NAME: string
  readonly OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../opencode/dist/types/src/node").Server.listen
    export type Listener = import("../../../opencode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../opencode/dist/types/src/node").Config.get
    export type Info = import("../../../opencode/dist/types/src/node").Config.Info
  }
  export namespace ProviderEnterprise {
    export const setCredentials: typeof import("../../../opencode/dist/types/src/node").ProviderEnterprise.setCredentials
  }
  export const bootstrap: typeof import("../../../opencode/dist/types/src/node").bootstrap
}
