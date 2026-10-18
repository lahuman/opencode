import { app } from "electron"
import { ENTERPRISE_ENABLED } from "../enterprise"
import { desktopRuntimeFeatures, type Channel } from "./runtime-features"

const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export { ENTERPRISE_ENABLED, desktopRuntimeFeatures }

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

export function desktopIdentity(input: { channel: Channel; enterprise: boolean }) {
  if (input.enterprise) return { appId: "com.company.sfmi", name: "CHAI" }
  if (input.channel === "dev" || input.channel === "local")
    return { appId: "ai.opencode.desktop.dev", name: "CHAI Dev" }
  if (input.channel === "beta") return { appId: "ai.opencode.desktop.beta", name: "CHAI Beta" }
  return { appId: "ai.opencode.desktop", name: "CHAI" }
}

const identity = desktopIdentity({ channel: app.isPackaged ? CHANNEL : "dev", enterprise: ENTERPRISE_ENABLED })
export const APP_NAME = identity.name
export const APP_ID = identity.appId

export const RUNTIME_FEATURES = desktopRuntimeFeatures({
  packaged: app.isPackaged,
  channel: CHANNEL,
  enterprise: ENTERPRISE_ENABLED,
})
export const UPDATER_ENABLED = RUNTIME_FEATURES.updater
