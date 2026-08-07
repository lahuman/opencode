import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/RequestDocks"
const projectID = "proj_request_docks"
const sessionID = "ses_request_docks"
const title = "Request dock regression"

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
    pageMessages: () => ({ items: [] }),
    permissions: requests.permissions,
    questions: requests.questions,
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
}
