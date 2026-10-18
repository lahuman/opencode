import { For, Show, createResource, createSignal } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Switch } from "@opencode/ui/switch"

import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "./skills.css"

export function SettingsSkills() {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [pending, setPending] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [packs, { mutate }] = createResource(() => platform.enterprise?.skillPacks() ?? Promise.resolve([]), {
    initialValue: [],
  })

  const toggle = async (id: string, name: string, enabled: boolean) => {
    if (!platform.enterprise) return
    setError()
    await updateSkillPack({
      confirm: () =>
        requestSkillPackConfirmation((actions, onClose) => {
          void dialog.push(
            () => (
              <DialogSkillPackRestart
                name={name}
                cancel={() => {
                  actions.cancel()
                  dialog.close()
                }}
                confirm={() => {
                  actions.confirm()
                  dialog.close()
                }}
              />
            ),
            onClose,
          )
        }),
      pending: (value) => setPending(value ? id : undefined),
      update: () => platform.enterprise!.setSkillPackEnabled(id, enabled),
      complete: mutate,
      fail: (failure) => setError(language.t(skillPackFailureKey(failure))),
    })
  }

  return (
    <div class="settings-section enterprise-skills">
      <div class="enterprise-skills-heading">
        <h2>{language.t("settings.skills.title")}</h2>
        <p>{language.t("settings.skills.description")}</p>
      </div>
      <Show when={error()}>{(message) => <div class="enterprise-skills-error">{message()}</div>}</Show>
      <SettingsList>
        <For each={packs.latest}>
          {(pack) => (
            <SettingsRow title={`${pack.displayName} ${pack.version}`} description={pack.description}>
              <div class="enterprise-skills-actions">
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
                <span class="enterprise-skills-pending">{language.t("settings.skills.pending")}</span>
              </Show>
            </SettingsRow>
          )}
        </For>
      </SettingsList>
    </div>
  )
}

function DialogSkillPackRestart(props: { name: string; cancel(): void; confirm(): void }) {
  const language = useLanguage()
  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("settings.skills.title")}
          description={language.t("settings.skills.confirm", { name: props.name })}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={props.cancel}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="danger" onClick={props.confirm}>
          {language.t("common.continue")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

export function requestSkillPackConfirmation(
  show: (actions: { cancel(): void; confirm(): void }, close: () => void) => void,
) {
  return new Promise<boolean>((resolve) => {
    const settled = { value: false }
    const complete = (value: boolean) => {
      if (settled.value) return
      settled.value = true
      resolve(value)
    }
    show(
      {
        cancel: () => complete(false),
        confirm: () => complete(true),
      },
      () => complete(false),
    )
  })
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
