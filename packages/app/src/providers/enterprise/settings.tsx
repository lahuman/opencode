import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { DialogCompanyProvider, useCompanyProviderSettingsState } from "@/components/dialog-company-provider"

export function SettingsCompanyProvider() {
  const dialog = useDialog()
  const language = useLanguage()
  const company = useCompanyProviderSettingsState()
  const providerCount = () =>
    language.plural("enterprise.provider.count", company.providers().length)
  const defaultPair = () => {
    const provider = company.defaultProvider()
    const model = company.defaultModel()
    if (!provider || !model) return language.t("enterprise.provider.copy.noDefault")
    return `${provider.id} / ${model.id}`
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto px-4 pb-10 sm:px-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex max-w-[720px] items-center pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.providers.title")}</h2>
        </div>
      </div>
      <div class="flex max-w-[720px] flex-col gap-1">
        <SettingsList>
          <div class="flex min-h-16 flex-wrap items-center justify-between gap-4 py-3">
            <div class="flex min-w-0 flex-col gap-1">
              <span class="text-14-medium text-text-strong">
                {language.t("enterprise.provider.copy.enterpriseProviders")}
              </span>
              <div class="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-12-regular text-text-weak">
                <span>{providerCount()}</span>
                <span class="truncate">{defaultPair()}</span>
                <span role="status" aria-live="polite" aria-atomic="true">
                  {company.status()}
                </span>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                size="small"
                variant="outline"
                onClick={() => dialog.show(() => <DialogCompanyProvider />, company.refreshStatus)}
              >
                {language.t("enterprise.provider.copy.manageProviders")}
              </Button>
              <Button
                size="small"
                variant="outline"
                disabled={company.checking() || !company.defaultProvider() || !company.defaultModel()}
                onClick={company.testConnection}
              >
                {company.checking() ? language.t("enterprise.provider.copy.testing") : language.t("enterprise.provider.copy.testConnection")}
              </Button>
            </div>
          </div>
        </SettingsList>
      </div>
    </div>
  )
}
