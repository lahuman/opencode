import { app } from "electron"
import { ENTERPRISE_ENABLED } from "../enterprise"
import { desktopRuntimeFeatures, type Channel } from "./runtime-features"

const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export { ENTERPRISE_ENABLED }
export { desktopRuntimeFeatures }

export function desktopIdentity(input: { channel: Channel; enterprise: boolean }) {
  if (input.enterprise) return { appId: "com.company.kernexa", name: "Kernexa" }
  if (input.channel === "dev") return { appId: "ai.opencode.desktop.dev", name: "OpenCode Dev" }
  if (input.channel === "beta") return { appId: "ai.opencode.desktop.beta", name: "OpenCode Beta" }
  return { appId: "ai.opencode.desktop", name: "OpenCode" }
}

export const RUNTIME_FEATURES = desktopRuntimeFeatures({
  packaged: app.isPackaged,
  channel: CHANNEL,
  enterprise: ENTERPRISE_ENABLED,
})
export const UPDATER_ENABLED = RUNTIME_FEATURES.updater
