import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"
import { ENTERPRISE_PROFILE, desktopNotificationOptions } from "../../enterprise"

export function createDesktopNotify(api: ElectronAPI): Platform["notify"] {
  return async (title, description, onClick) => {
    const focused = await api.getWindowFocused().catch(() => document.hasFocus())

    if (focused) return

    const notification = new Notification(title, {
      ...desktopNotificationOptions(ENTERPRISE_PROFILE, description ?? "", window.location.href),
      silent: true,
    })

    notification.onclick = () => {
      void api.showWindow()
      void api.setWindowFocus()
      onClick?.()
      notification.close()
    }
  }
}
