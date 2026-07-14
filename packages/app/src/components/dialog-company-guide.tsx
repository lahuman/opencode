import { Dialog } from "@opencode-ai/ui/dialog"
import { lazy, onCleanup, onMount } from "solid-js"
import type { CommandOption } from "@/context/command"
import type { Platform } from "@/context/platform"

const Markdown = lazy(async () => {
  const { Markdown } = await import("@opencode-ai/session-ui/markdown")
  return { default: Markdown }
})

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
  open: (guide: CompanyGuide) => void
  reportFailure: () => void
}): CommandOption | undefined {
  if (!input.enterprise) return
  return {
    id: "company.guide.open",
    title: "Company AI Guide",
    category: input.category,
    onSelect: async () => {
      const guide = await input.enterprise?.readGuide().catch(() => undefined)
      if (!guide) return input.reportFailure()
      input.open(guide)
    },
  }
}

export function DialogCompanyGuide(props: CompanyGuide) {
  let body: HTMLDivElement | undefined
  onMount(() => {
    const frame = requestAnimationFrame(() => body?.focus())
    onCleanup(() => cancelAnimationFrame(frame))
  })

  return (
    <Dialog
      size="large"
      class="h-full min-h-0 overflow-hidden"
      title={
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="text-16-medium text-text-strong">Company AI Guide</span>
          <span class="max-w-full break-words text-11-regular text-text-weak">Version {props.version}</span>
        </div>
      }
    >
      <div
        ref={body}
        data-component="company-guide"
        class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-5"
        tabIndex={0}
        role="region"
        aria-label="Company AI Guide content"
        autofocus
      >
        <Markdown text={props.markdown} class="min-w-0 text-14-regular [overflow-wrap:anywhere]" />
      </div>
    </Dialog>
  )
}
