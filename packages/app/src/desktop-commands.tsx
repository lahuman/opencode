import { useDialog } from "@opencode-ai/ui/context/dialog"
import {
  createCompanyGuideCommand,
  DialogCompanyGuide,
  restoreCompanyGuideFocus,
} from "@/components/dialog-company-guide"
import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"

export function DesktopCommands() {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  command.register("desktop", () => {
    const commands: CommandOption[] = []
    if (platform.platform === "desktop" && platform.exportDebugLogs) {
      commands.push({
        id: "logs.export",
        title: "Export logs",
        category: language.t("command.category.settings"),
        onSelect: () => {
          void platform.exportDebugLogs?.()
        },
      })
    }
    const companyGuide = createCompanyGuideCommand({
      enterprise: platform.enterprise,
      category: language.t("command.category.settings"),
      open: (guide, origin) =>
        dialog.show(() => <DialogCompanyGuide {...guide} />, () => restoreCompanyGuideFocus(origin)),
      reportFailure: () => showToast({ title: language.t("common.requestFailed") }),
    })
    if (companyGuide) commands.push(companyGuide)
    return commands
  })

  return null
}
