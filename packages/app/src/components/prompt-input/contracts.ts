import type { useLocal } from "@/context/local"
import type { Prompt, usePrompt } from "@/context/prompt"
import type { PromptInputHistory } from "./history-store"
import type { FollowupDraft } from "./submit"
import type { createPermissionMutation } from "@/context/permission-mutation"
import type { Session } from "@opencode-ai/sdk/v2/client"

export type PromptInputState = ReturnType<typeof usePrompt>

export type PromptInputSubmission = {
  abort: () => Promise<void> | void
  handleSubmit: (event: Event) => Promise<void> | void
}

export type PromptInputControls = {
  agents: {
    available: { name: string; hidden?: boolean; mode: string }[]
    options: string[]
    current: string
    loading: boolean
    visible: boolean
    select: (name: string | undefined) => void
  }
  model: {
    selection: ReturnType<typeof useLocal>["model"]
    paid: boolean
    loading: boolean
  }
  approval: {
    visible: () => boolean
    current: () => NonNullable<Session["approvalMode"]>
    options: readonly NonNullable<Session["approvalMode"]>[]
    pending: () => boolean
    select: (mode: NonNullable<Session["approvalMode"]>) => Promise<void>
    run: ReturnType<typeof createPermissionMutation>["run"]
    resetDraft: () => void
  }
  session: {
    id?: string
    tabs: {
      active: () => string | undefined
      all: () => string[]
      open: (tab: string) => void | Promise<void>
      setActive: (tab: string) => void
    }
    reviewPanel: {
      opened: () => boolean
      open: () => void
    }
  }
}

export interface PromptInputProps {
  class?: string
  state?: PromptInputState
  history?: PromptInputHistory
  submission?: PromptInputSubmission
  controls: PromptInputControls
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
}
