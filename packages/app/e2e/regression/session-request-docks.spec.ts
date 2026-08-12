import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/RequestDocks"
const projectID = "proj_request_docks"
const sessionID = "ses_request_docks"
const title = "Request dock regression"

function waitForGet(page: Page, server: string, path: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.ok() &&
      new URL(response.url()).origin === server &&
      new URL(response.url()).pathname === path,
    { timeout: 30_000 },
  )
}

test("does not show the approval selector in the composer", async ({ page }) => {
  await mockServer(page, { permissions: [] })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const dock = page.locator('[data-component="session-prompt-dock"]')
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-component="prompt-input"]')).toBeVisible()
  await expect(dock.locator('[data-component="prompt-approval-control"]')).toHaveCount(0)
  await expect(dock.getByText("Ask for approval")).toHaveCount(0)
  await expect(dock.getByText("Approve for me")).toHaveCount(0)
})

test("shows a pending question dock", async ({ page }) => {
  await mockServer(page, {
    questions: [
      {
        id: "question-request",
        sessionID,
        questions: [
          {
            header: "Implementation",
            question: "Which implementation should be used?",
            options: [
              { label: "Minimal", description: "Use the smallest correct change" },
              { label: "Extended", description: "Include additional behavior" },
            ],
          },
        ],
      },
    ],
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeVisible()
  await expect(question.getByRole("radio", { name: /Extended/ })).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).toHaveCount(0)

  const rejectRequests: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (new URL(request.url()).pathname === `/api/session/${sessionID}/question/question-request/reject`)
      rejectRequests.push(request.url())
  })

  await question.locator('[data-component="icon-button"][data-icon="chevron-down"]').click()
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByText("Select one answer")).toBeHidden()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeHidden()
  await expect(question.getByRole("radio", { name: /Extended/ })).toBeHidden()
  await expect(question.getByRole("button", { name: "Dismiss" })).toBeVisible()
  await expect(question.getByRole("button", { name: "Submit" })).toBeVisible()
  await expect(page.locator('[data-component="question-minimized-dock"]')).toHaveCount(0)
  expect(rejectRequests).toEqual([])

  await question.locator('[data-component="icon-button"][data-icon="chevron-down"]').click()
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeVisible()
  expect(rejectRequests).toEqual([])

  await question.getByRole("radio", { name: /Minimal/ }).click()
  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/question/question-request/reply`,
  )
  await question.getByRole("button", { name: "Submit" }).click()
  expect((await reply).postDataJSON()).toEqual({ answers: [["Minimal"]] })
})

test("shows a pending permission dock", async ({ page }) => {
  await mockServer(page, {
    permissions: [
      {
        id: "permission-request",
        sessionID,
        permission: "bash",
        patterns: ["git status", "git diff"],
        metadata: {},
        always: [],
      },
    ],
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(permission).toBeVisible()
  await expect(permission.getByText("git status")).toBeVisible()
  await expect(permission.getByText("git diff")).toBeVisible()
  await expect(permission.locator('[data-slot="permission-footer-actions"] button')).toHaveCount(2)
  await expect(page.locator('[data-component="prompt-input"]')).toHaveCount(0)

  const reply = page.waitForRequest((request) => request.method() === "POST")
  await permission.getByRole("button", { name: "Allow once" }).click()
  const request = await reply
  expect(new URL(request.url()).pathname).toBe(`/api/session/${sessionID}/permission/permission-request/reply`)
  expect(request.postDataJSON()).toEqual({ reply: "once" })
})

test("rejects a pending permission", async ({ page }) => {
  await mockServer(page, {
    permissions: [
      {
        id: "permission-reject",
        sessionID,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      },
    ],
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/permission/permission-reject/reply`,
  )
  await permission.getByRole("button", { name: "Deny" }).click()
  expect((await reply).postDataJSON()).toEqual({ reply: "reject" })
})
test("confirms a directory permission for all sessions until restart", async ({ page }) => {
  await mockServer(page, {
    permissions: [
      {
        id: "permission-always",
        sessionID,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: ["git *"],
      },
    ],
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(permission.getByRole("button", { name: "Allow always" })).toBeVisible()

  const replies: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (new URL(request.url()).pathname !== `/api/session/${sessionID}/permission/permission-always/reply`) return
    replies.push(request.postData() ?? "")
  })

  await permission.getByRole("button", { name: "Allow always" }).click()
  await expect(permission.getByText("git *", { exact: true })).toBeVisible()
  await expect(
    permission.getByText("These patterns will be allowed for all sessions in this directory until OpenCode restarts.", {
      exact: true,
    }),
  ).toBeVisible()
  await expect(permission.getByRole("button", { name: "Cancel" })).toBeVisible()
  await expect(permission.getByRole("button", { name: "Confirm" })).toBeVisible()
  expect(replies).toEqual([])

  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/permission/permission-always/reply`,
  )
  await permission.getByRole("button", { name: "Confirm" }).click()
  expect((await reply).postDataJSON()).toEqual({ reply: "always" })
})

test("resets always confirmation when the permission request changes", async ({ page }) => {
  const transport = await installSseTransport(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    retry: 20,
  })
  await mockServer(page, {
    permissions: [
      {
        id: "permission-z",
        sessionID,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: ["git *"],
      },
    ],
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await permission.getByRole("button", { name: "Allow always" }).click()
  await expect(permission.getByText("git *", { exact: true })).toBeVisible()
  await expect(permission.getByRole("button", { name: "Confirm" })).toBeVisible()

  await transport.send({
    directory,
    payload: {
      type: "permission.asked",
      properties: {
        id: "permission-a",
        sessionID,
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: ["npm *"],
      },
    },
  })

  await expect(permission.getByText("npm test", { exact: true })).toBeVisible()
  await expect(permission.getByRole("button", { name: "Allow always" })).toBeVisible()
  await expect(permission.getByRole("button", { name: "Confirm" })).toHaveCount(0)
  await expect(permission.getByText("git *", { exact: true })).toHaveCount(0)
})

test("recovers a completed Plan while the event stream is still connecting", { timeout: 180_000 }, async ({ page }) => {
  const transport = await installSseTransport(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${
      process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    }`,
    retry: 20,
    emitConnected: false,
  })
  const status: Record<string, unknown> = { [sessionID]: { type: "busy" } }
  const questions: unknown[] = []
  let completed = false
  const user = {
    info: {
      id: "message-plan-user",
      sessionID,
      role: "user",
      time: { created: 1700000001000 },
      agent: "plan",
      model: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    parts: [{ id: "part-plan-user", type: "text", text: "Create the recovery plan" }],
  }
  const assistant = {
    info: {
      id: "message-plan-assistant",
      sessionID,
      role: "assistant",
      time: { created: 1700000002000, completed: 1700000003000 },
      agent: "plan",
      modelID: "claude-opus-4-6",
      providerID: "opencode",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: "part-plan-exit",
        type: "tool",
        tool: "plan_exit",
        state: {
          status: "completed",
          input: { plan: "# Recovered Plan\n\nApply the minimal synchronization fix." },
          output: "",
          metadata: { agent: "plan" },
          time: { created: 1700000002000, completed: 1700000003000 },
        },
      },
    ],
  }

  await mockServer(page, {
    questions: () => questions,
    sessionStatus: status,
    pageMessages: () => ({ items: completed ? [user, assistant] : [user] }),
    agents: [
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
      },
      {
        id: "plan",
        name: "Plan",
        mode: "primary",
        hidden: false,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
      },
    ],
  })
  const initialMessages = waitForGet(page, transport.server, `/api/session/${sessionID}/message`)
  const initialQuestions = waitForGet(page, transport.server, "/api/question/request")
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const first = await transport.waitForConnection()
  await Promise.all([initialMessages, initialQuestions])
  expect(first.path).toBe("/api/event")
  await expectSessionTitle(page, title)
  await expect(page.locator('[data-slot="text-shimmer-char-base"]', { hasText: "Syncing status" })).toBeVisible()

  const recoveryMessages = waitForGet(page, transport.server, `/api/session/${sessionID}/message`)
  const recoveryQuestions = waitForGet(page, transport.server, "/api/question/request")
  completed = true
  status[sessionID] = { type: "idle" }
  questions.push({
    id: "question-plan-recovered",
    sessionID,
    questions: [
      {
        header: "Plan complete",
        question: "The plan is ready. What should happen next?",
        options: [
          { label: "Build now", description: "Switch to Build and implement the plan" },
          { label: "Keep planning", description: "Stay in Plan mode" },
        ],
      },
    ],
    tool: { messageID: "message-plan-assistant", callID: "part-plan-exit" },
  })
  await Promise.all([recoveryMessages, recoveryQuestions])

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(page.locator('[data-timeline-part-id="part-plan-exit"] [data-component="plan-part"]')).toContainText(
    "Recovered Plan",
    { timeout: 30_000 },
  )
  await expect(question.getByText("The plan is ready. What should happen next?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Build now/ })).toBeVisible()
  await expect(page.locator('[data-slot="session-turn-thinking"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="text-shimmer-char-base"]', { hasText: "Syncing status" })).toHaveCount(0)
  const second = await transport.waitForConnection({ after: first.id, timeout: 15_000 })
  expect(second.id).toBeGreaterThan(first.id)
  expect(second.path).toBe("/api/event")
  expect((await transport.connections()).find((item) => item.id === first.id)?.endedBy).toBe("abort")
})

test("restores the draft caret before typing after a request dock closes", async ({ page }) => {
  const transport = await installSseTransport(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    retry: 20,
  })
  await mockServer(page, { questions: [] })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  const draft = "keep the caret at the end"
  await editor.fill(draft)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  for (let index = 0; index < 4; index++) await page.keyboard.press("ArrowLeft")
  const cursor = draft.length - 4
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const selection = window.getSelection()
        if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return -1
        const range = selection.getRangeAt(0).cloneRange()
        range.selectNodeContents(element)
        range.setEnd(selection.anchorNode!, selection.anchorOffset)
        return range.toString().length
      }),
    )
    .toBe(cursor)
  await transport.send({
    directory,
    payload: {
      type: "question.asked",
      properties: {
        id: "question-caret",
        sessionID,
        questions: [
          {
            header: "Continue",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue the session" }],
          },
        ],
        tool: { messageID: "message-caret", callID: "call-caret" },
      },
    },
  })
  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question).toBeVisible()
  await expect(editor).toHaveCount(0)

  await transport.send({
    directory,
    payload: { type: "question.rejected", properties: { sessionID, requestID: "question-caret" } },
  })
  await expect(question).toHaveCount(0)
  await expect(editor).toBeVisible()
  await page.keyboard.press("x")

  await expect(editor).toHaveText(`${draft.slice(0, cursor)}x${draft.slice(cursor)}`)
})

async function mockServer(
  page: Page,
  requests: {
    permissions?: unknown[] | (() => unknown[])
    questions?: unknown[] | (() => unknown[])
    agents?: unknown[]
    pageMessages?: (sessionID: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
    sessionStatus?: Record<string, unknown>
  },
) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "request-docks",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "request-docks",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: requests.pageMessages ?? (() => ({ items: [] })),
    permissions: requests.permissions,
    questions: requests.questions,
    agents: requests.agents,
    sessionStatus: requests.sessionStatus,
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
}
test("switches the composer to Build from the durable plan approval message", async ({ page }) => {
  const transport = await installSseTransport(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    retry: 20,
  })
  await mockServer(page, {
    questions: [],
    agents: [
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
      },
      {
        id: "plan",
        name: "Plan",
        mode: "primary",
        hidden: false,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
      },
    ],
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  const agent = page.getByRole("button", { name: "Choose agent", includeHidden: true })
  const composer = page.locator('[data-component="prompt-input-v2"]')
  const editor = composer.locator('[data-component="prompt-input"]')
  const add = composer.getByRole("button", { name: "Add images and files" })
  const shell = page.getByRole("menuitem", { name: "Shell command" })

  await expect(agent).toContainText("Build")
  await add.click()
  await expect(shell).toBeVisible()
  await shell.click()
  await expect(editor).toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await editor.press("Escape")

  await editor.fill("keep this draft")
  await page.keyboard.press("Control+Shift+X")
  await expect(editor).toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await page.keyboard.press("Control+.")
  await expect(agent).toContainText("Plan")
  await expect(editor).not.toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await expect(editor).toHaveText("keep this draft")

  await editor.fill("")
  await add.click()
  await expect(shell).toHaveCount(0)
  await page.keyboard.press("Escape")
  await editor.click()
  await page.keyboard.press("Control+Shift+X")
  await expect(editor).not.toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await editor.press("!")
  await expect(editor).toHaveText("!")
  await expect(editor).not.toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await editor.fill("")

  await transport.send({
    directory,
    payload: {
      type: "question.asked",
      properties: {
        id: "question-plan-exit",
        sessionID,
        questions: [
          {
            header: "Plan complete",
            question: "The plan is ready. What should happen next?",
            options: [
              { label: "Build now", description: "Switch to Build and implement the plan" },
              { label: "Keep planning", description: "Stay in Plan mode" },
            ],
          },
        ],
        tool: { messageID: "message-plan-exit", callID: "call-plan-exit" },
      },
    },
  })

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await question.getByRole("radio", { name: /Build now/ }).click()
  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/question/question-plan-exit/reply`,
  )
  await question.getByRole("button", { name: "Submit" }).click()
  expect((await reply).postDataJSON()).toEqual({ answers: [["Build now"]] })

  const approval = {
    directory,
    payload: {
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id: "message-plan-approved",
          sessionID,
          role: "user",
          time: { created: 1700000001000 },
          agent: "build",
          model: { providerID: "opencode", modelID: "claude-opus-4-6" },
        },
      },
    },
  }
  await transport.burst([
    {
      directory,
      payload: {
        type: "question.replied",
        properties: { sessionID, requestID: "question-plan-exit", answers: [["Build now"]] },
      },
    },
    approval,
  ])

  await expect(agent).toContainText("Build")
  await transport.send({
    ...approval,
    payload: {
      ...approval.payload,
      properties: {
        ...approval.payload.properties,
        info: {
          ...approval.payload.properties.info,
          id: "message-plan-approved-next",
        },
      },
    },
  })
  await page.keyboard.press("Control+.")
  await expect(agent).toContainText("Plan")
  await transport.send(approval)
  await expect(agent).toContainText("Plan")
})
