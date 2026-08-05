import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import solidPlugin from "vite-plugin-solid"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type { Platform } from "@/context/platform"

let DialogProvider: typeof import("@opencode-ai/ui/context/dialog").DialogProvider
let PlatformProvider: typeof import("@/context/platform").PlatformProvider
let LanguageProvider: typeof import("@/context/language").LanguageProvider
let createPromptState: typeof import("@/context/prompt-state").createPromptState
let SessionPermissionDock: typeof import("@/pages/session/composer/session-permission-dock").SessionPermissionDock
let PromptInputV2Select: typeof import("@opencode-ai/session-ui/v2/prompt-input").PromptInputV2Select
let PromptInput: typeof import("@/components/prompt-input").PromptInput
let createPromptInputHistory: typeof import("@/components/prompt-input").createPromptInputHistory

const platform = {
  platform: "web",
  openExternal() {},
  async restart() {},
  async notify() {},
} satisfies Platform

const mounted: Array<() => void> = []
const isolated = process.env.OPENCODE_PLAN_APPROVAL_UI_ISOLATED === "1"
const cases = [
  "shows manual fallback review context",
  "omits review context when no summary exists",
  "hides Always when the request has no reusable patterns",
  "keeps the V2 approval selector disabled while a write is pending",
  "renders the legacy approval trigger with its accessible name",
] as const

if (isolated) {
  const solid = solidPlugin({ dev: false })
  Bun.plugin({
    name: "plan-approval-solid-jsx",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async (args) => {
        const result = await solid.transform!(await Bun.file(args.path).text(), args.path)
        if (!result) throw new Error(`Solid JSX transform failed for ${args.path}`)
        return { contents: typeof result === "string" ? result : result.code, loader: "ts" }
      })
    },
  })
}

function mount(view: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  const View = () => view()
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: platform,
        get children() {
          return () =>
            createComponent(LanguageProvider, {
              locale: "en",
              get children() {
                return () =>
                  createComponent(DialogProvider, {
                    get children() {
                      return () => createComponent(View, {})
                    },
                  })
              },
            })
        },
      }),
    host,
  )
  mounted.push(() => {
    dispose()
    host.remove()
  })
  return host
}

function permissionRequest(review?: PermissionRequest["review"]): PermissionRequest {
  return {
    id: "permission-request",
    sessionID: "session-id",
    permission: "bash",
    patterns: ["git status"],
    metadata: {},
    always: [],
    review,
  }
}

if (isolated) {
  beforeAll(
    async () => {
      mock.module("@/context/sdk", () => ({
        useSDK: () => () => ({ directory: "/repo" }),
      }))
      mock.module("@/context/sync", () => ({
        useSync: () => () => ({
          data: {
            session_diff: {},
            session_working: () => false,
            message: {},
            command: [],
            reference: [],
            mcp_resource: {},
          },
          session: { get: () => undefined },
        }),
      }))
      mock.module("@/context/file", () => ({
        selectionFromLines: (selection: { start: number; end: number }) => ({
          startLine: selection.start,
          startChar: 0,
          endLine: selection.end,
          endChar: 0,
        }),
        useFile: () => ({
          pathFromTab: () => undefined,
          tab: (path: string) => path,
          load: async () => undefined,
          searchFilesAndDirectories: async () => [],
        }),
      }))
      mock.module("@/context/layout", () => ({
        useLayout: () => ({ fileTree: { setTab() {} } }),
      }))
      mock.module("@/context/comments", () => ({
        useComments: () => ({
          all: () => [],
          active: () => undefined,
          focus: () => undefined,
          setActive() {},
          setFocus() {},
          replace() {},
          remove() {},
        }),
      }))
      mock.module("@/context/command", () => ({
        useCommand: () => ({
          options: [],
          register() {},
          trigger() {},
          keybind: () => "",
          keybindParts: () => [],
        }),
      }))
      mock.module("@/context/permission", () => ({
        usePermission: () => ({
          isAutoAccepting: () => false,
          isAutoAcceptingDirectory: () => false,
        }),
      }))

      const dialog = await import("@opencode-ai/ui/context/dialog")
      const platform = await import("@/context/platform")
      const language = await import("@/context/language")
      const promptState = await import("@/context/prompt-state")
      const permissionDock = await import("@/pages/session/composer/session-permission-dock")
      const promptInputV2 = await import("@opencode-ai/session-ui/v2/prompt-input")
      const promptInput = await import("@/components/prompt-input")

      DialogProvider = dialog.DialogProvider
      PlatformProvider = platform.PlatformProvider
      LanguageProvider = language.LanguageProvider
      createPromptState = promptState.createPromptState
      SessionPermissionDock = permissionDock.SessionPermissionDock
      PromptInputV2Select = promptInputV2.PromptInputV2Select
      PromptInput = promptInput.PromptInput
      createPromptInputHistory = promptInput.createPromptInputHistory
    },
    { timeout: 30_000 },
  )

  afterEach(() => {
    mounted.splice(0).forEach((dispose) => dispose())
    document.body.replaceChildren()
  })

  test("shows manual fallback review context", () => {
    const host = mount(() =>
      createComponent(SessionPermissionDock, {
        request: permissionRequest({ risk: "high", reason: "The command can overwrite tracked files." }),
        responding: false,
        onDecide: () => undefined,
      }),
    )

    expect(host.textContent).toContain("high")
    expect(host.textContent).toContain("The command can overwrite tracked files.")
  })

  test("omits review context when no summary exists", () => {
    const host = mount(() =>
      createComponent(SessionPermissionDock, {
        request: permissionRequest(),
        responding: false,
        onDecide: () => undefined,
      }),
    )

    expect(host.querySelector('[data-slot="permission-review"]')).toBeNull()
  })

  test("hides Always when the request has no reusable patterns", () => {
    const host = mount(() =>
      createComponent(SessionPermissionDock, {
        request: permissionRequest(),
        responding: false,
        onDecide: () => undefined,
      }),
    )
    const actions = host.querySelectorAll<HTMLButtonElement>('[data-slot="permission-footer-actions"] button')

    expect(actions).toHaveLength(2)
    expect([...actions].some((button) => button.textContent === "Allow always")).toBeFalse()
  })

  test("keeps the V2 approval selector disabled while a write is pending", async () => {
    const [selected, setSelected] = createSignal("auto_review")
    const [opened, setOpened] = createSignal(false)
    const host = mount(() =>
      createComponent(PromptInputV2Select, {
        title: "Approval mode",
        options: [
          { id: "ask", label: "Ask for approval" },
          { id: "auto_review", label: "Approve for me" },
        ],
        get current() {
          return selected()
        },
        disabled: true,
        onOpenChange: setOpened,
        onSelect: setSelected,
      }),
    )
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Approval mode"]')

    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain("Approve for me")
    expect(trigger?.disabled).toBeTrue()
    trigger?.click()
    await Promise.resolve()
    expect(opened()).toBeFalse()
    expect(selected()).toBe("auto_review")
  })

  test("renders the legacy approval trigger with its accessible name", () => {
    const state = createPromptState()
    const host = mount(() =>
      createComponent(PromptInput, {
        state,
        history: createPromptInputHistory(),
        submission: { abort() {}, handleSubmit() {} },
        controls: {
          agents: {
            available: [],
            options: ["plan"],
            current: "plan",
            loading: false,
            visible: true,
            select() {},
          },
          model: {
            selection: {
              current: () => ({ id: "model", name: "Model", provider: { id: "provider", name: "Provider" } }),
              list: () => [],
              visible: () => true,
              set() {},
              variant: { list: () => [], current: () => undefined, set() {} },
            },
            paid: false,
            loading: false,
          },
          approval: {
            visible: () => true,
            current: () => "auto_review",
            options: ["ask", "auto_review"],
            pending: () => false,
            async select() {},
            run: async () => undefined,
            resetDraft() {},
          },
          session: {
            tabs: {
              active: () => undefined,
              all: () => [],
              open() {},
              setActive() {},
            },
            reviewPanel: { opened: () => false, open() {} },
          },
        },
      }),
    )

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Approval mode"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain("Approve for me")
  })
} else {
  let output = ""
  let exitCode = -1

  beforeAll(
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--conditions=browser",
          "--preload",
          "./happydom.ts",
          "./test-browser/plan-approval-ui.test.tsx",
        ],
        {
          cwd: `${import.meta.dir}/..`,
          env: { ...process.env, OPENCODE_PLAN_APPROVAL_UI_ISOLATED: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      exitCode = code
      output = `${stdout}\n${stderr}`
      if (exitCode !== 0) throw new Error(output)
    },
    { timeout: 60_000 },
  )

  for (const name of cases) {
    test(name, () => {
      expect(`${exitCode}\n${output}`).toContain(`(pass) ${name}`)
    })
  }
}
