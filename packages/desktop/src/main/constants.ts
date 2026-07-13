import { app } from "electron"
import { ENTERPRISE_ENABLED } from "../enterprise"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export { ENTERPRISE_ENABLED }

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && !ENTERPRISE_ENABLED
