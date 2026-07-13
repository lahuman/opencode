export type Channel = "dev" | "beta" | "prod"

export function desktopRuntimeFeatures(input: { packaged: boolean; channel: Channel; enterprise: boolean }) {
  return {
    updater: input.packaged && input.channel !== "dev" && !input.enterprise,
    wsl: !input.enterprise,
  }
}
