# Kernexa Desktop Build Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a successful Kernexa Desktop `Build now` approval switch the current task to Build and persist Build as the default for every subsequently created Desktop task across projects and app restarts.

**Architecture:** Keep the change inside `packages/app`. A small pure classifier recognizes only Plan-exit Build approvals, `LocalProvider` owns a Desktop-global agent preference through the existing persistence layer, and the question mutation updates current and global state only after a successful reply. Existing session state remains higher priority than the global default.

**Tech Stack:** TypeScript, SolidJS, TanStack Solid Query, existing `Persist` storage abstraction, Bun test, Playwright.

**Design:** `docs/superpowers/specs/2026-08-15-kernexa-desktop-build-default-design.md`

## Global Constraints

- Kernexa Desktop behavior is the priority; do not change TUI or other clients.
- A successful `Build now` reply changes both the current task and the Desktop-global new-task default.
- Existing per-task agent selections take precedence over the global default.
- Failed replies, `Keep planning`, dismissal, custom answers, ordinary agent selection, and unrelated questions must not change the global default.
- Do not update server `default_agent`, server routes, Protocol, generated SDK files, model selection, or model variants.
- Do not add a dependency or a settings UI.
- Use the existing `Persist.serverGlobal` and session persistence patterns.
- Run tests and `bun typecheck` from `packages/app`; never invoke `tsc` directly.
- Keep changes limited to the files listed below and avoid unrelated refactoring.

## File Structure

- Create `packages/app/src/pages/session/composer/plan-build-approval.ts`: pure recognition of a successful Plan-exit `Build now` answer, including the narrow canonical-request fallback used before a linked part hydrates.
- Create `packages/app/src/pages/session/composer/plan-build-approval.test.ts`: focused classifier tests for linked parts, canonical fallback, false positives, and non-Build answers.
- Modify `packages/app/src/context/local.tsx`: persist and resolve the Desktop-global agent default while preserving current session/draft precedence.
- Modify `packages/app/src/pages/session/composer/session-question-dock.tsx`: apply current and global Build state only in the successful reply callback.
- Modify `packages/app/e2e/regression/session-request-docks.spec.ts`: prove successful transition, persistence, new-task inheritance, per-task override, and failure behavior without transition events.

---

### Task 1: Classify Plan-exit Build approvals

**Files:**
- Create: `packages/app/src/pages/session/composer/plan-build-approval.ts`
- Create: `packages/app/src/pages/session/composer/plan-build-approval.test.ts`

**Interfaces:**
- Consumes: SDK `QuestionRequest`, `QuestionAnswer`, and `Part` values already present in the composer sync store.
- Produces: `isPlanBuildApproval(input: { request: QuestionRequest; answers: QuestionAnswer[]; parts: Part[] }): boolean` for `SessionQuestionDock`.

- [ ] **Step 1: Write the failing classifier tests**

Create `packages/app/src/pages/session/composer/plan-build-approval.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { Part, QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2"
import { isPlanBuildApproval } from "./plan-build-approval"

const canonicalQuestion = {
  header: "Build Agent",
  question: "The plan is ready. Would you like to switch to Build?",
  custom: false,
  options: [
    { label: "Build now", description: "Switch to Build and send an implementation request" },
    { label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
  ],
} satisfies QuestionInfo

function request(question: QuestionInfo = canonicalQuestion) {
  return {
    id: "question-plan-exit",
    sessionID: "session-plan",
    questions: [question],
    tool: { messageID: "message-plan", callID: "call-plan-exit" },
  } satisfies QuestionRequest
}

function part(tool: string) {
  return {
    id: "part-plan-exit",
    sessionID: "session-plan",
    messageID: "message-plan",
    type: "tool",
    callID: "call-plan-exit",
    tool,
    state: { status: "running", input: { plan: "# Plan" }, time: { start: 1 } },
  } satisfies Part
}

describe("isPlanBuildApproval", () => {
  test("accepts Build now for a linked plan_exit part", () => {
    expect(
      isPlanBuildApproval({
        request: request({ ...canonicalQuestion, header: "Changed display copy" }),
        answers: [["Build now"]],
        parts: [part("plan_exit")],
      }),
    ).toBe(true)
  })

  test("accepts the canonical Plan-exit request before its part hydrates", () => {
    expect(isPlanBuildApproval({ request: request(), answers: [["Build now"]], parts: [] })).toBe(true)
  })

  test("rejects a canonical-looking request linked to another tool", () => {
    expect(isPlanBuildApproval({ request: request(), answers: [["Build now"]], parts: [part("question")] })).toBe(
      false,
    )
  })

  test("rejects an unrelated Build now option and non-Build answers", () => {
    expect(
      isPlanBuildApproval({
        request: request({ ...canonicalQuestion, question: "Run the deployment now?" }),
        answers: [["Build now"]],
        parts: [],
      }),
    ).toBe(false)
    expect(isPlanBuildApproval({ request: request(), answers: [["Keep planning"]], parts: [] })).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and confirm the RED state**

Run from `packages/app`:

```bash
bun test src/pages/session/composer/plan-build-approval.test.ts
```

Expected: FAIL because `./plan-build-approval` does not exist.

- [ ] **Step 3: Implement the minimum classifier**

Create `packages/app/src/pages/session/composer/plan-build-approval.ts`:

```ts
import type { Part, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"

const canonical = {
  header: "Build Agent",
  question: "The plan is ready. Would you like to switch to Build?",
  options: [
    { label: "Build now", description: "Switch to Build and send an implementation request" },
    { label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
  ],
}

export function isPlanBuildApproval(input: {
  request: QuestionRequest
  answers: QuestionAnswer[]
  parts: Part[]
}) {
  const answer = input.answers[0]
  const tool = input.request.tool
  if (!tool || input.answers.length !== 1 || answer?.length !== 1 || answer[0] !== "Build now") return false

  const linked = input.parts.find(
    (part) => part.type === "tool" && part.messageID === tool.messageID && part.callID === tool.callID,
  )
  if (linked?.type === "tool") return linked.tool === "plan_exit"

  const question = input.request.questions[0]
  if (input.request.questions.length !== 1 || !question) return false
  if (question.header !== canonical.header || question.question !== canonical.question) return false
  if (question.custom !== false || question.multiple === true || question.options.length !== 2) return false

  return question.options.every(
    (option, index) =>
      option.label === canonical.options[index]?.label && option.description === canonical.options[index]?.description,
  )
}
```

- [ ] **Step 4: Run the focused test and confirm the GREEN state**

Run from `packages/app`:

```bash
bun test src/pages/session/composer/plan-build-approval.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit the independently tested classifier**

```bash
git add packages/app/src/pages/session/composer/plan-build-approval.ts packages/app/src/pages/session/composer/plan-build-approval.test.ts
git commit -m "fix(app): classify plan build approvals"
```

---

### Task 2: Persist Build as the Kernexa Desktop default

**Files:**
- Modify: `packages/app/src/context/local.tsx:85-109,190-223`
- Modify: `packages/app/src/pages/session/composer/session-question-dock.tsx:1-15,64-76,225-236`
- Modify: `packages/app/e2e/regression/session-request-docks.spec.ts:7-21,431-631`

**Interfaces:**
- Consumes: `isPlanBuildApproval(...)` from Task 1 and the existing `Persist.serverGlobal`, `useLocal`, and `useSync` APIs.
- Produces: `local.agent.setDefault(name: string | undefined): void`; new providers use that persisted default only when no session/draft agent is explicit.

- [ ] **Step 1: Add failing browser regressions before production changes**

Add these shared fixtures near the constants in `packages/app/e2e/regression/session-request-docks.spec.ts`:

```ts
const modeAgents = [
  {
    id: "plan",
    name: "Plan",
    mode: "primary",
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
  },
  {
    id: "build",
    name: "Build",
    mode: "primary",
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
  },
]

function planExitQuestion(id: string) {
  return {
    id,
    sessionID,
    questions: [
      {
        header: "Build Agent",
        question: "The plan is ready. Would you like to switch to Build?",
        custom: false,
        options: [
          { label: "Build now", description: "Switch to Build and send an implementation request" },
          { label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
        ],
      },
    ],
    tool: { messageID: "message-plan-assistant", callID: "part-plan-exit" },
  }
}

function planExitMessages() {
  return [
    {
      info: {
        id: "message-plan-user",
        sessionID,
        role: "user",
        time: { created: 1700000001000 },
        agent: "plan",
        model: { providerID: "opencode", modelID: "claude-opus-4-6" },
      },
      parts: [{ id: "part-plan-user", type: "text", text: "Prepare the implementation plan" }],
    },
    {
      info: {
        id: "message-plan-assistant",
        sessionID,
        role: "assistant",
        time: { created: 1700000002000 },
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
            status: "running",
            input: { plan: "# Approved Plan\n\nApply the Desktop default." },
            time: { created: 1700000002000 },
          },
        },
      ],
    },
  ]
}

async function seedAgentDefault(page: Page, agent: "plan" | "build") {
  await page.addInitScript((value) => {
    localStorage.setItem("opencode.global.dat:agent-default", JSON.stringify({ agent: value }))
  }, agent)
}

async function openNewTask(page: Page) {
  await page.locator('[data-slot="titlebar-v2"]').getByRole("button", { name: "New session" }).click()
  await expect(page).toHaveURL(/\/new-session\?draftId=/)
}
```

Add these tests after the existing durable approval regression:

```ts
test("persists Build as the Kernexa Desktop default after Plan approval", async ({ page }) => {
  const requestID = "question-plan-default"
  let answered = false
  await seedAgentDefault(page, "plan")
  await mockServer(page, {
    questions: () => (answered ? [] : [planExitQuestion(requestID)]),
    agents: modeAgents,
    pageMessages: () => ({ items: planExitMessages() }),
  })
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (new URL(request.url()).pathname !== `/api/session/${sessionID}/question/${requestID}/reply`) return
    answered = true
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const agent = page.getByRole("button", { name: "Choose agent", includeHidden: true })
  await expect(agent).toContainText("Plan")

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await question.getByRole("radio", { name: /Build now/ }).click()
  const reply = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/session/${sessionID}/question/${requestID}/reply`,
  )
  await question.getByRole("button", { name: "Submit" }).click()
  expect((await reply).status()).toBe(204)
  await expect(agent).toContainText("Build")

  await page.reload()
  await expect(agent).toContainText("Build")
  await openNewTask(page)
  await expect(agent).toContainText("Build")
  await page.reload()
  await expect(agent).toContainText("Build")

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.keyboard.press("Control+.")
  await expect(agent).toContainText("Plan")
  await page.reload()
  await expect(agent).toContainText("Plan")
  await openNewTask(page)
  await expect(agent).toContainText("Build")
})

test("keeps the Desktop default unchanged when Plan approval fails", async ({ page }) => {
  const requestID = "question-plan-failed"
  await seedAgentDefault(page, "plan")
  await mockServer(page, {
    questions: [planExitQuestion(requestID)],
    agents: modeAgents,
    pageMessages: () => ({ items: planExitMessages() }),
  })
  await page.route(`**/api/session/${sessionID}/question/${requestID}/reply`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ message: "reply failed" }),
    }),
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const agent = page.getByRole("button", { name: "Choose agent", includeHidden: true })
  await expect(agent).toContainText("Plan")

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await question.getByRole("radio", { name: /Build now/ }).click()
  const reply = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/session/${sessionID}/question/${requestID}/reply`,
  )
  await question.getByRole("button", { name: "Submit" }).click()
  expect((await reply).status()).toBe(500)
  await expect(page.getByText("Request failed")).toBeVisible()
  await expect(agent).toContainText("Plan")

  await openNewTask(page)
  await expect(agent).toContainText("Plan")
})
```

- [ ] **Step 2: Run the browser tests and confirm the RED state**

Run from `packages/app`:

```bash
bun run test:e2e -- e2e/regression/session-request-docks.spec.ts --grep "Desktop default"
```

Expected: FAIL. The successful reply remains Plan without a later live event, and the failed-reply test's new task ignores the seeded global Plan preference and falls back to Build.

- [ ] **Step 3: Add the Desktop-global agent preference to `LocalProvider`**

In `packages/app/src/context/local.tsx`, add a separate persisted store after the existing session-scoped `saved` store:

```ts
const [defaults, setDefaults] = persisted(
  Persist.serverGlobal(serverSDK().scope, "agent-default"),
  createStore<{ agent?: string }>({}),
)
```

Change the agent resolution and add a setter without changing ordinary `agent.set(...)` behavior:

```ts
const agent = {
  list,
  visible: agentsVisible,
  current() {
    return pickAgent(agentsVisible() ? (scope()?.agent ?? defaults.agent ?? store.current) : "build")
  },
  set(name: string | undefined) {
    const item = pickAgent(name)
    if (!item) {
      setStore("current", undefined)
      return
    }

    batch(() => {
      setStore("current", item.name)
      setStore("last", {
        type: "agent",
        agent: item.name,
        model: item.model,
        variant: item.variant ?? null,
      })
      const prev = scope()
      const next = {
        agent: item.name,
        model: item.model ?? prev?.model,
        variant: item.variant ?? prev?.variant,
      } satisfies State
      const session = id()
      if (session) {
        setSaved("session", session, next)
        return
      }
      setStore("draft", next)
    })
  },
  setDefault(name: string | undefined) {
    setDefaults("agent", list().find((item) => item.name === name)?.name)
  },
  move(direction: 1 | -1) {
    const items = list()
    if (items.length === 0) {
      setStore("current", undefined)
      return
    }

    let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
    if (next < 0) next = items.length - 1
    if (next >= items.length) next = 0
    const item = items[next]
    if (!item) return
    agent.set(item.name)
  },
}
```

The existing `scope()?.agent` remains first, so this change does not overwrite an existing task selection. The new store contains no model or variant.

- [ ] **Step 4: Wire successful Plan approval to current and global state**

In `packages/app/src/pages/session/composer/session-question-dock.tsx`, add imports:

```ts
import { useLocal } from "@/context/local"
import { useSync } from "@/context/sync"
import { isPlanBuildApproval } from "./plan-build-approval"
```

Initialize the contexts beside the existing SDK and language contexts:

```ts
const local = useLocal()
const sync = useSync()
```

Replace only the reply mutation's success callback:

```ts
onSuccess: (_, answers) => {
  replied = true
  cache.delete(cacheKey)
  if (
    !isPlanBuildApproval({
      request: props.request,
      answers,
      parts: props.request.tool ? (sync().data.part[props.request.tool.messageID] ?? []) : [],
    })
  )
    return
  local.agent.set("build")
  local.agent.setDefault("build")
},
```

Leave `onMutate`, `onError`, rejection, and the existing live `message.updated` / `message.part.updated` listeners unchanged.

- [ ] **Step 5: Run focused unit and browser tests**

Run from `packages/app`:

```bash
bun test src/pages/session/composer/plan-build-approval.test.ts src/context/local-agent.test.ts src/utils/persist.test.ts
bun run test:e2e -- e2e/regression/session-request-docks.spec.ts --grep "Desktop default"
```

Expected: all selected unit tests PASS; both Desktop-default browser tests PASS without injecting a Build message or completed Plan-exit event.

- [ ] **Step 6: Run App type checks and the complete request-dock regression**

Run from `packages/app`:

```bash
bun typecheck
bun run typecheck:e2e
bun run test:e2e -- e2e/regression/session-request-docks.spec.ts
```

Expected: both type checks PASS and every request-dock Playwright test PASS, including the existing durable-message replay test.

- [ ] **Step 7: Inspect the final diff and commit the behavior**

```bash
git diff --check
git diff -- packages/app/src/context/local.tsx packages/app/src/pages/session/composer/session-question-dock.tsx packages/app/e2e/regression/session-request-docks.spec.ts
git status --short
git add packages/app/src/context/local.tsx packages/app/src/pages/session/composer/session-question-dock.tsx packages/app/e2e/regression/session-request-docks.spec.ts
git commit -m "fix(app): persist Build as desktop default"
git status --short
```

Expected: the diff contains only the approved App behavior and regression coverage; the final status is clean.
