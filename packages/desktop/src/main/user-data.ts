import { posix, win32 } from "node:path"

const ENTERPRISE_WINDOWS_USER_DATA_ID = "com.company.kernexa"

export function resolveDesktopUserDataPath(input: {
  platform: NodeJS.Platform
  enterprise: boolean
  appId: string
  localAppData?: string
  appData: () => string
}) {
  if (input.enterprise && input.platform === "win32") {
    if (!input.localAppData) {
      throw new Error("LOCALAPPDATA is required for Kernexa on Windows")
    }
    return win32.join(input.localAppData, ENTERPRISE_WINDOWS_USER_DATA_ID)
  }
  if (input.platform === "win32") return win32.join(input.appData(), input.appId)
  return posix.join(input.appData(), input.appId)
}
