import { EnterpriseDialog } from "@/providers/enterprise/presentation"
import { lazy, onCleanup, onMount } from "solid-js"
import type { CommandOption } from "@/shell/commands/command"
import type { Platform } from "@/runtime/platform/platform"

const Markdown = lazy(async () => {
  const { Markdown } = await import("@opencode/session-ui/markdown")
  return { default: Markdown }
})

import { useLanguage } from "@/runtime/i18n/language"

type CompanyGuide = {
  version: string
  markdown: string
}

export function openEditionHelp(input: {
  enterprise: boolean
  href: string
  trigger: (id: string) => void
  openLink: (href: string) => void
}) {
  if (input.enterprise) return input.trigger("company.guide.open")
  input.openLink(input.href)
}

export function createCompanyGuideCommand(input: {
  enterprise: Platform["enterprise"]
  category: string
  title: string
  open: (guide: CompanyGuide, origin?: HTMLElement) => void
  reportFailure: () => void
}): CommandOption | undefined {
  if (!input.enterprise) return
  return {
    id: "company.guide.open",
    title: input.title,
    category: input.category,
    onSelect: async (_source, _input, origin) => {
      const guide = await input.enterprise?.readGuide().catch(() => undefined)
      if (!guide) return input.reportFailure()
      input.open(guide, origin)
    },
  }
}

export function restoreCompanyGuideFocus(origin?: HTMLElement) {
  requestAnimationFrame(() => {
    if (!origin?.isConnected) return
    if (origin.matches(":disabled, [aria-disabled='true']")) return
    origin.focus()
  })
}

export function DialogCompanyGuide(props: CompanyGuide) {
  const language = useLanguage()
  let body: HTMLDivElement | undefined
  onMount(() => {
    const frame = requestAnimationFrame(() => body?.focus())
    onCleanup(() => cancelAnimationFrame(frame))
  })

  return (
    <EnterpriseDialog
      size="large"
      class="h-full min-h-0 overflow-hidden"
      title={
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="text-16-medium text-text-strong">{language.t("enterprise.guide.title")}</span>
          <span class="max-w-full break-words text-11-regular text-text-weak">{language.t("enterprise.guide.version", { version: props.version })}</span>
        </div>
      }
    >
      <div
        ref={body}
        data-component="company-guide"
        class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-5"
        tabIndex={0}
        role="region"
        aria-label={language.t("enterprise.guide.content")}
        autofocus
      >
        <Markdown text={props.markdown} class="min-w-0 text-14-regular [overflow-wrap:anywhere]" />
      </div>
    </EnterpriseDialog>
  )
}
