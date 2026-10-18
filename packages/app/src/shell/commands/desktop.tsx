import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useCommand, type CommandOption } from "./command"
import { useDialog } from "@opencode/ui/context/dialog"
import {
  createCompanyGuideCommand,
  DialogCompanyGuide,
  restoreCompanyGuideFocus,
} from "@/components/dialog-company-guide"
import { showToast } from "@/shell/notifications/toast"

export function DesktopCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()

  command.register("desktop", () => {
    const commands: CommandOption[] = []

    if (platform.platform === "desktop" && platform.exportDebugLogs)
      commands.push({
        id: "logs.export",
        title: language.t("command.logs.export"),
        category: language.t("command.category.settings"),
        onSelect: () => void platform.exportDebugLogs?.(),
      })
    const guide = createCompanyGuideCommand({
      enterprise: platform.enterprise,
      title: language.t("enterprise.guide.title"),
      category: language.t("command.category.settings"),
      open: (guide, origin) =>
        void dialog.show(
          () => <DialogCompanyGuide {...guide} />,
          () => restoreCompanyGuideFocus(origin),
        ),
      reportFailure: () => showToast({ title: language.t("common.requestFailed") }),
    })
    if (guide) commands.push(guide)

    return commands
  })

  return null
}
