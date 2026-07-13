import type { WslDistroProbe, WslOpencodeCheck, WslServerItem, WslServersState } from "../../preload/types"

export function unavailableWslIntegration(enabled: boolean) {
  const error = enabled ? "WSL is only available on Windows" : "WSL integration is disabled in this build"
  return {
    unavailable: () => {
      throw new Error(error)
    },
    state: (): WslServersState => ({
      runtime: { available: false, version: null, error },
      installed: [],
      online: [],
      distroProbes: {},
      opencodeChecks: {},
      pendingRestart: false,
      servers: [],
      job: null,
    }),
  }
}

export function wslServerIdToRestart(servers: WslServerItem[], distro: string) {
  return servers.find((item) => item.config.distro === distro)?.config.id
}

export function clearWslDistroState(
  distroProbes: Record<string, WslDistroProbe>,
  opencodeChecks: Record<string, WslOpencodeCheck>,
  distro: string,
) {
  const nextDistroProbes = { ...distroProbes }
  const nextOpencodeChecks = { ...opencodeChecks }
  delete nextDistroProbes[distro]
  delete nextOpencodeChecks[distro]
  return { distroProbes: nextDistroProbes, opencodeChecks: nextOpencodeChecks }
}

export function wslTerminalArgs(distro?: string | null) {
  return ["/c", "start", "", "wsl", ...(distro ? ["-d", distro] : [])]
}

export function requireWslIpcString(name: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`Invalid ${name}`)
}

export function requireWslIpcStrings(name: string, value: unknown) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}`)
  const values = value.map((item) => requireWslIpcString(name, item))
  if (values.length > 0) return values
  throw new Error(`Invalid ${name}`)
}
