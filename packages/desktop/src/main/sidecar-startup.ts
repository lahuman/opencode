import type { EnterpriseProviderCredentials } from "./enterprise-credentials"
import type { EnterpriseProviderCatalog } from "./enterprise-providers"

type Runtime = {
  inherited: Record<string, string | undefined>
  platform: NodeJS.Platform
  packaged: boolean
}

type StartInput = {
  hostname: string
  port: number
  password: string
  userDataPath: string
  catalog?: EnterpriseProviderCatalog
  credentials?: EnterpriseProviderCredentials
}

export function createSidecarEnv(overrides: Record<string, string> = {}, runtime: Runtime) {
  const env = {
    ...Object.fromEntries(
      Object.entries(runtime.inherited).flatMap(([key, value]) =>
        value === undefined ? [] : ([[key, String(value)]] as const),
      ),
    ),
    ...overrides,
  }
  delete env.DEBUG
  delete env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG
  delete env.OPENCODE_ENTERPRISE_CREDENTIALS
  if (runtime.platform === "linux") delete env.LD_PRELOAD
  if (!runtime.packaged) env.OPENCODE_DISABLE_CHANNEL_DB = "1"
  return env
}

export function createSidecarStartCommand(input: StartInput) {
  return { type: "start" as const, ...input }
}

export function postSidecarStartCommand(
  input: Omit<StartInput, "catalog" | "credentials">,
  owner: Pick<StartInput, "catalog" | "credentials">,
  postMessage: (command: ReturnType<typeof createSidecarStartCommand>) => void,
) {
  const command = createSidecarStartCommand({
    ...input,
    catalog: owner.catalog,
    credentials: owner.credentials,
  })
  postMessage(command)
  owner.catalog = undefined
  owner.credentials = undefined
  command.catalog = undefined
  command.credentials = undefined
}
