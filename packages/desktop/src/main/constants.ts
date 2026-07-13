import { app } from "electron"
import { ENTERPRISE_ENABLED } from "../enterprise"
import { desktopRuntimeFeatures, type Channel } from "./runtime-features"

const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export { ENTERPRISE_ENABLED }
export { desktopRuntimeFeatures }

export const RUNTIME_FEATURES = desktopRuntimeFeatures({
  packaged: app.isPackaged,
  channel: CHANNEL,
  enterprise: ENTERPRISE_ENABLED,
})
export const UPDATER_ENABLED = RUNTIME_FEATURES.updater
