import { For, Show, createResource, createSignal } from "solid-js"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"

import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export function SettingsSkillsV2() {
  const language = useLanguage()
  const platform = usePlatform()
  const [pending, setPending] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [packs, { mutate }] = createResource(
    () => platform.enterprise?.skillPacks() ?? Promise.resolve([]),
    { initialValue: [] },
  )

  const toggle = async (id: string, name: string, enabled: boolean) => {
    if (!platform.enterprise) return
    setError()
    await updateSkillPack({
      confirm: () => window.confirm(language.t("settings.skills.confirm", { name })),
      pending: (value) => setPending(value ? id : undefined),
      update: () => platform.enterprise!.setSkillPackEnabled(id, enabled),
      complete: mutate,
      fail: (failure) => setError(language.t(skillPackFailureKey(failure))),
    })
  }

  return (
    <div class="settings-v2-section settings-v2-skills">
      <div class="settings-v2-skills-heading">
        <h2>{language.t("settings.skills.title")}</h2>
        <p>{language.t("settings.skills.description")}</p>
      </div>
      <Show when={error()}>{(message) => <div class="settings-v2-skills-error">{message()}</div>}</Show>
      <SettingsListV2>
        <For each={packs.latest}>
          {(pack) => (
            <SettingsRowV2
              title={`${pack.displayName} ${pack.version}`}
              description={pack.description}
            >
              <div class="settings-v2-skills-actions">
                <button type="button" onClick={() => void platform.enterprise?.openSkillPackSource(pack.id)}>
                  {language.t("settings.skills.source")}
                </button>
                <button type="button" onClick={() => void platform.openPath?.(pack.license)}>
                  {language.t("settings.skills.license")}
                </button>
                <Switch
                  checked={pack.enabled}
                  disabled={Boolean(pending())}
                  onChange={(enabled) => void toggle(pack.id, pack.displayName, enabled)}
                />
              </div>
              <Show when={pending() === pack.id}>
                <span class="settings-v2-skills-pending">{language.t("settings.skills.pending")}</span>
              </Show>
            </SettingsRowV2>
          )}
        </For>
      </SettingsListV2>
    </div>
  )
}

export async function updateSkillPack<T>(input: {
  confirm: () => Promise<boolean>
  pending: (value: boolean) => void
  update: () => Promise<T>
  complete: (value: T) => void
  fail: (failure: unknown) => void
}) {
  if (!(await input.confirm())) return false
  input.pending(true)
  try {
    input.complete(await input.update())
    return true
  } catch (failure) {
    input.fail(failure)
    return false
  } finally {
    input.pending(false)
  }
}

export function skillPackFailureKey(failure: unknown) {
  const code = failure instanceof Error ? failure.message : String(failure)
  if (code.includes("restart_failed_recovery_failed")) return "settings.skills.error.recoveryFailed" as const
  if (code.includes("restart_failed_rolled_back")) return "settings.skills.error.rolledBack" as const
  return "settings.skills.error.generic" as const
}
