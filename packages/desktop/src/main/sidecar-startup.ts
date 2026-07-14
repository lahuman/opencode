import type { EnterpriseCredentials } from "./enterprise-credentials"

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
  credentials?: EnterpriseCredentials
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
  delete env.OPENCODE_ENTERPRISE_CREDENTIALS
  if (runtime.platform === "linux") delete env.LD_PRELOAD
  if (!runtime.packaged) env.OPENCODE_DISABLE_CHANNEL_DB = "1"
  return env
}

export function createSidecarStartCommand(input: StartInput) {
  return { type: "start" as const, ...input }
}

export function postSidecarStartCommand(
  input: Omit<StartInput, "credentials">,
  owner: Pick<StartInput, "credentials">,
  postMessage: (command: ReturnType<typeof createSidecarStartCommand>) => void,
) {
  const command = createSidecarStartCommand({ ...input, credentials: owner.credentials })
  postMessage(command)
  owner.credentials = undefined
  command.credentials = undefined
}
