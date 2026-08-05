import { base64Encode } from "@opencode-ai/core/util/encode"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { PromptInputControls } from "@/components/prompt-input/contracts"
import type { PromptProjectControls } from "@/components/prompt-project-selector"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import type { QueryOptionsApi } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { serverName, ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { pathKey } from "@/utils/path-key"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import type { createPermissionMutation } from "@/context/permission-mutation"

type ApprovalMode = NonNullable<Session["approvalMode"]>

export function createApprovalModeControl(input: {
  agent: Accessor<string | undefined>
  session: Accessor<Pick<Session, "id" | "approvalMode"> | undefined>
  sessionKey: Accessor<string>
  directory: Accessor<string>
  approvalMutation: ReturnType<typeof createPermissionMutation>
  update: (input: { sessionID: string; approvalMode: ApprovalMode }) => Promise<void>
  disableAutoAccept: (sessionID: string, directory: string) => void
  onError: (error: unknown) => void
}) {
  const [draft, setDraft] = createSignal<ApprovalMode>("ask")
  let draftKey = input.sessionKey()
  const resetForSessionKey = () => {
    const key = input.sessionKey()
    if (key === draftKey) return
    draftKey = key
    setDraft("ask")
  }
  createEffect(on(input.sessionKey, resetForSessionKey, { defer: true }))

  const current = () => {
    resetForSessionKey()
    const session = input.session()
    if (session) return session.approvalMode ?? "ask"
    return draft()
  }
  const resetDraft = () => {
    draftKey = input.sessionKey()
    setDraft("ask")
  }
  const select = async (approvalMode: ApprovalMode) => {
    if (approvalMode === current()) return
    await input.approvalMutation
      .run(async () => {
        const session = input.session()
        if (!session) {
          resetForSessionKey()
          setDraft(approvalMode)
          return
        }
        const directory = input.directory()
        await input.update({ sessionID: session.id, approvalMode })
        if (approvalMode === "auto_review") input.disableAutoAccept(session.id, directory)
      })
      .catch(input.onError)
  }

  return {
    visible: () => input.agent() === "plan",
    current,
    options: ["ask", "auto_review"] as const,
    pending: input.approvalMutation.pending,
    select,
    run: input.approvalMutation.run,
    resetDraft,
  }
}

export function createPromptInputController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">
  model?: ModelSelection
}) {
  const layout = useLayout()
  const local = useLocal()
  const sdk = useSDK()
  const sync = useSync()
  const permission = usePermission()
  const language = useLanguage()
  const providers = useProviders(() => sdk().directory)
  const view = layout.view(input.sessionKey)
  const agentsQuery = createQuery(() => input.queryOptions.agents(pathKey(sdk().directory)))
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null))
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sdk().directory)))
  const permissionState = permission.currentServerState()
  const approval = createApprovalModeControl({
    agent: () => local.agent.current()?.name,
    session: () => {
      const sessionID = input.sessionID()
      if (!sessionID) return
      return sync().session.get(sessionID)
    },
    sessionKey: input.sessionKey,
    directory: () => sdk().directory,
    approvalMutation: permissionState.approvalMutation,
    update: async (value) => {
      const result = await sdk().client.session.update(value)
      if (!result.data) throw new Error("Failed to update session approval mode")
    },
    disableAutoAccept: permissionState.disableAutoAccept,
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t, language.t("common.requestFailed")),
      }),
  })

  createEffect(() => {
    const cleanup = permissionState.approvalMutation.registerDraftReset(sdk().directory, approval.resetDraft)
    onCleanup(cleanup)
  })

  return createMemo<PromptInputControls>(() => {
    return {
      agents: {
        available: sync().data.agent,
        options: local.agent.list().map((agent) => agent.name),
        current: local.agent.current()?.name ?? "",
        loading: agentsQuery.isLoading,
        visible: local.agent.visible(),
        select: local.agent.set,
      },
      model: {
        selection: input.model ?? local.model,
        paid: providers.paid().length > 0,
        loading:
          (local.agent.visible() && agentsQuery.isLoading) ||
          providersQuery.isLoading ||
          globalProvidersQuery.isLoading,
      },
      approval,
      session: {
        id: input.sessionID(),
        tabs: layout.tabs(input.sessionKey),
        reviewPanel: view.reviewPanel,
      },
    }
  })
}

export function createPromptProjectControls() {
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projectServer = () => serverSDK().server
  const projectServerCtx = createMemo(() => global.ensureServerCtx(projectServer()))
  const projects = createMemo(() => {
    if (server.list.length <= 1) {
      return search.draftId ? projectServerCtx().projects.list() : layout.projects.list()
    }
    return server.list.flatMap((conn) => {
      const item = { key: ServerConnection.key(conn), name: serverName(conn) }
      return global
        .ensureServerCtx(conn)
        .projects.list()
        .map((project) => ({ ...project, server: item }))
    })
  })
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (search.draftId) {
      if (!conn) return
      const target = global.ensureServerCtx(conn)
      target.projects.open(worktree)
      target.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: ServerConnection.key(conn), directory: worktree })
      return
    }

    if (!serverKey) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      navigate(`/${base64Encode(worktree)}/session`)
      return
    }

    if (!conn) return
    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn) return
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    server: server.list.length > 1 ? ServerConnection.key(projectServer()) : undefined,
    select: selectProject,
    add: addProject,
  }))
}
