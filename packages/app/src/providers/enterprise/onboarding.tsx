import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Schema } from "effect"
import { For, Show } from "solid-js"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { EnterpriseDialog } from "./presentation"

export function EnterpriseOnboarding() {
  const platform = usePlatform()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState, , ready] = persisted(
    Persist.global("enterprise.onboarding"),
    Schema.Struct({ dismissed: Schema.mutableKey(Schema.Boolean) }),
    { dismissed: false },
  )

  return (
    <Show when={platform.enterprise && ready() && !state.dismissed}>
      <aside
        class="fixed bottom-14 end-5 z-50 flex w-64 flex-col gap-3 rounded-lg border border-border-weak-base bg-surface-raised-base p-4 shadow-lg"
        aria-label={language.t("enterprise.onboarding.card.ariaLabel")}
      >
        <Button
          variant="ghost"
          class="self-end"
          aria-label={language.t("enterprise.onboarding.card.dismissLabel")}
          onClick={() => setState("dismissed", true)}
        >
          {language.t("common.close")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setState("dismissed", true)
            void dialog.show(() => <OnboardingGuide />)
          }}
        >
          {language.t("enterprise.onboarding.card.title")}
        </Button>
        <p class="text-13-regular text-text-weak">{language.t("enterprise.onboarding.card.description")}</p>
      </aside>
    </Show>
  )
}

function OnboardingGuide() {
  const language = useLanguage()
  const sections = ["analysis", "implementation", "verification"] as const
  return (
    <EnterpriseDialog title={language.t("enterprise.onboarding.drawer.header")} size="large">
      <div class="flex flex-col gap-4 text-14-regular text-text-strong">
        <h2 class="text-16-medium">{language.t("enterprise.onboarding.drawer.title")}</h2>
        <p>{language.t("enterprise.onboarding.drawer.intro")}</p>
        <For each={sections}>
          {(section) => (
            <section>
              <h3 class="text-14-medium">{language.t(`enterprise.onboarding.${section}.title`)}</h3>
              <p>{language.t(`enterprise.onboarding.${section}.description`)}</p>
            </section>
          )}
        </For>
        <p>{language.t("enterprise.onboarding.drawer.offline")}</p>
        <p>{language.t("enterprise.onboarding.drawer.guide")}</p>
      </div>
    </EnterpriseDialog>
  )
}
