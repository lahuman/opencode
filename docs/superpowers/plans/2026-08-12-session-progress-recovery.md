# Session Progress Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover missed Plan output, pending interaction requests, and terminal session state within about 10 seconds of event silence while allowing legitimate model runs to continue for any duration.

**Architecture:** Keep the fix inside the App synchronization layer. Add an attempt-local timeout for an SSE stream that never emits `server.connected`, extract the existing V1/V2 pending-request hydration for reuse, and reconcile stale sessions through the existing REST status and message APIs. Existing server-session message merging remains authoritative.

**Tech Stack:** TypeScript, SolidJS, TanStack Solid Query, Bun tests, Playwright.

## Global Constraints

- Change App code only. Do not change provider adapters, model execution, server protocols, or generated clients.
- Ten seconds is a synchronization health threshold, not a model timeout. Never interrupt, abort, restart, or mark an active model run idle.
- Start the SSE handshake timer only after protocol detection. Abort only the current event-stream attempt if `server.connected` is not received.
- Run REST recovery while the global connection is `connecting`, `connected`, or `disconnected`.
- Fetch active status once per recovery window, then force-hydrate each target session independently.
- Set an inactive session idle only after hydration succeeds and both the active-check generation and status revision are still current.
- Reconcile permission and question lists through the existing V1/V2 endpoints. Do not clear them merely because a session is inactive.
- Preserve live request events that overlap a REST refresh by comparing the pending-list snapshot before applying the response.
- Do not let one unresolved session hydration block another session or queue unlimited forced refreshes for the same session.
- Add no dependency and no new endpoint.
- Run tests and type checks from packages/app, never from the repository root.

## File Responsibility Map

| File | Responsibility |
| --- | --- |
| `packages/app/src/context/server-sdk.tsx` | Time out only an SSE attempt that has not emitted `server.connected`. |
| `packages/app/src/context/server-sdk.test.ts` | Verify attempt-local timeout and cancellation after a healthy greeting. |
| `packages/app/src/context/global-sync/bootstrap.ts` | Extract and reuse authoritative V1/V2 permission and question hydration. |
| `packages/app/src/context/global-sync/bootstrap.test.ts` | Verify protocol routing, normalization, stale removal, and live-event race protection. |
| `packages/app/src/context/server-sync.tsx` | Detect stale busy sessions, coalesce status checks, hydrate progress independently, and invoke pending-request recovery. |
| `packages/app/src/context/server-sync.test.ts` | Verify timing, active/inactive behavior, generation and revision guards, failure isolation, and long-running safety. |
| `packages/app/e2e/utils/sse-transport.ts` | Allow a regression test to open an SSE response without emitting `server.connected`. |
| `packages/app/e2e/regression/session-request-docks.spec.ts` | Prove a Plan result and Build question recover from REST while the event stream remains unhealthy. |

No change is planned for `packages/app/src/context/server-session.ts`; its existing forced hydration and merge rules are reused and regression-tested.

---

## Task 1: Retry an SSE attempt that never becomes connected

**Files:**

- Modify: `packages/app/src/context/server-sdk.tsx`
- Test: `packages/app/src/context/server-sdk.test.ts`

- [ ] Add failing unit tests for an attempt-local connection timeout.

Update the Bun import and server-sdk imports, then add:

    import { describe, expect, test, vi } from "bun:test"
    import {
      adaptServerEvent,
      coalesceServerEvents,
      enqueueServerEvent,
      resumeStreamAfterPageShow,
      startEventStreamConnectTimeout,
    } from "./server-sdk"

    describe("event stream connection timeout", () => {
      test("aborts only the stream attempt after ten seconds", () => {
        vi.useFakeTimers()
        try {
          const root = new AbortController()
          const attempt = new AbortController()
          startEventStreamConnectTimeout(attempt)

          vi.advanceTimersByTime(9_999)
          expect(attempt.signal.aborted).toBe(false)
          expect(root.signal.aborted).toBe(false)

          vi.advanceTimersByTime(1)
          expect(attempt.signal.aborted).toBe(true)
          expect(root.signal.aborted).toBe(false)
        } finally {
          vi.useRealTimers()
        }
      })

      test("keeps a connected attempt alive after the deadline", () => {
        vi.useFakeTimers()
        try {
          const attempt = new AbortController()
          const cancel = startEventStreamConnectTimeout(attempt)

          cancel()
          cancel()
          vi.advanceTimersByTime(10_000)

          expect(attempt.signal.aborted).toBe(false)
        } finally {
          vi.useRealTimers()
        }
      })
    })

- [ ] Run the focused test and confirm it fails because the helper is not exported.

From `packages/app`:

    bun test --conditions=solid --preload ./happydom.ts ./src/context/server-sdk.test.ts

Expected failure: `startEventStreamConnectTimeout` is missing.

- [ ] Add the smallest timeout helper beside the existing exported stream helpers.

    const SERVER_CONNECTED_TIMEOUT_MS = 10_000

    export function startEventStreamConnectTimeout(attempt: AbortController) {
      const timer = setTimeout(() => attempt.abort(), SERVER_CONNECTED_TIMEOUT_MS)
      return () => clearTimeout(timer)
    }

- [ ] Arm the timeout after protocol detection and cancel it on `server.connected` and in the attempt cleanup.

Keep the existing outer retry loop. Replace only the stream-handling portion with this shape:

    const kind = await protocol
    const cancelConnectTimeout = startEventStreamConnectTimeout(attempt)
    try {
      const events =
        kind === "v1"
          ? (await eventSdk.global.event({ signal: attempt.signal })).stream
          : eventApi.event.subscribe({ signal: attempt.signal })
      let yielded = Date.now()
      for await (const event of events) {
        streamErrorLogged = false
        const legacy = "payload" in event
        if (legacy && event.payload.type === "sync") continue
        const directory = legacy ? (event.directory ?? "global") : (event.location?.directory ?? "global")
        const payload = legacy ? (event.payload as Event) : adaptServerEvent(event)
        if (payload.type === "server.connected") {
          cancelConnectTimeout()
          setConnection("connected")
        }
        if (enqueueServerEvent(queue, { directory, payload })) schedule()

        if (Date.now() - yielded < STREAM_YIELD_MS) continue
        yielded = Date.now()
        await wait(0)
      }
    } finally {
      cancelConnectTimeout()
    }

Do not arm the timer when the attempt controller is created: protocol detection can legitimately consume up to two five-second probes. Do not abort the root controller.

- [ ] Run the focused test and App type check.

    bun test --conditions=solid --preload ./happydom.ts ./src/context/server-sdk.test.ts
    bun typecheck

- [ ] Commit the task.

    git add packages/app/src/context/server-sdk.tsx packages/app/src/context/server-sdk.test.ts
    git commit -m "fix(app): retry silent event streams"

---

## Task 2: Extract authoritative pending-request refresh

**Files:**

- Modify: `packages/app/src/context/global-sync/bootstrap.ts`
- Test: `packages/app/src/context/global-sync/bootstrap.test.ts`

- [ ] Add failing tests for the extracted V1/V2 refresh function.

Import `refreshPendingRequests` in `bootstrap.test.ts`. Reuse `directoryState()` and a real `createServerSession`. Remember `ses_pending` and `ses_stale` in `/project` before calling the helper so `session.resolve` does not require another HTTP fixture.

Add a V1 test with these canonical responses:

    const permission = {
      id: "perm_v1",
      sessionID: "ses_pending",
      permission: "bash",
      patterns: ["git status"],
      always: ["git *"],
      metadata: { command: "git status" },
      tool: { messageID: "msg_v1", callID: "call_v1" },
    }
    const question = {
      id: "question_v1",
      sessionID: "ses_pending",
      questions: [
        {
          header: "Plan complete",
          question: "Build the approved plan?",
          options: [
            { label: "Build now", description: "Switch to Build" },
            { label: "Keep planning", description: "Stay in Plan" },
          ],
        },
      ],
      tool: { messageID: "msg_v1", callID: "call_v1" },
    }

Make the legacy list methods return those values and make the V2 request-list methods throw if called. Assert:

    expect(permissionCalls).toBe(1)
    expect(questionCalls).toBe(1)
    expect(session.data.permission.ses_pending).toEqual([permission])
    expect(session.data.question.ses_pending).toEqual([question])
    expect(session.data.permission.ses_stale).toEqual([])
    expect(session.data.question.ses_stale).toEqual([])

Add a V2 test whose permission API returns:

    const rawPermission = {
      id: "perm_v2",
      sessionID: "ses_pending",
      action: "bash",
      resources: ["git status"],
      save: ["git *"],
      metadata: { command: "git status" },
      source: { type: "tool", messageID: "msg_v2", callID: "call_v2" },
    }

Make the legacy list methods throw if called. Assert the exact location inputs and normalized canonical result:

    expect(permissionInputs).toEqual([{ location: { directory: "/project" } }])
    expect(questionInputs).toEqual([{ location: { directory: "/project" } }])
    expect(session.data.permission.ses_pending).toEqual([
      {
        id: "perm_v2",
        sessionID: "ses_pending",
        permission: "bash",
        patterns: ["git status"],
        always: ["git *"],
        metadata: { command: "git status" },
        tool: { messageID: "msg_v2", callID: "call_v2" },
      },
    ])
    expect(session.data.question.ses_pending).toEqual([question])

- [ ] Add a failing overlap test so a stale REST result cannot undo a live request event.

Use deferred permission and question responses. Start `refreshPendingRequests`, then apply a live `permission.asked` event and a live `question.replied` event before resolving the REST calls with the older lists. Assert that the new permission remains and the replied question is not re-added.

    expect(session.data.permission.ses_pending?.map((item) => item.id)).toEqual(["perm_live"])
    expect(session.data.question.ses_pending).toEqual([])

- [ ] Run the focused test and confirm the new import fails.

    bun test --conditions=solid --preload ./happydom.ts ./src/context/global-sync/bootstrap.test.ts

Expected failure: `refreshPendingRequests` is missing.

- [ ] Extract the existing request-list logic without adding a module or dependency.

Add the shared API type and a stable request snapshot:

    type PendingRequestApi = {
      readonly permission: PermissionApi
      readonly question: QuestionApi
      readonly session: SessionApi
    }

    function pendingRequestSnapshot(input: readonly { id: string }[] | undefined) {
      return JSON.stringify((input ?? []).slice().sort((a, b) => cmp(a.id, b.id)))
    }

Add this exported function above `bootstrapDirectory`:

    export async function refreshPendingRequests(input: {
      directory: string
      sdk: OpencodeClient
      api: PendingRequestApi
      store: Store<State>
      setStore: SetStoreFunction<State>
      session?: ServerSession
      protocol?: Promise<ServerProtocol>
    }) {
      const permissionBefore = new Map(
        Object.entries(input.session?.data.permission ?? input.store.permission).map(([sessionID, requests]) => [
          sessionID,
          pendingRequestSnapshot(requests),
        ]),
      )
      const questionBefore = new Map(
        Object.entries(input.session?.data.question ?? input.store.question).map(([sessionID, requests]) => [
          sessionID,
          pendingRequestSnapshot(requests),
        ]),
      )

      const permissions = async () => {
        const requests = await retry(async () => {
          if ((await input.protocol) === "v1") return (await input.sdk.permission.list()).data ?? []
          return input.api.permission.request
            .list({ location: { directory: input.directory } })
            .then((result) => result.data.map(normalizePermissionRequest))
        })
        const grouped = groupBySession(requests.filter((request) => !!request.id && !!request.sessionID))
        const ids = [...new Set(requests.map((request) => request.sessionID))]
        await (input.session
          ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
          : warmSessions({ ids, store: input.store, setStore: input.setStore, api: input.api.session }))

        batch(() => {
          const current = input.session?.data.permission ?? input.store.permission
          const sessionIDs = new Set([...Object.keys(current), ...Object.keys(grouped)])
          sessionIDs.forEach((sessionID) => {
            if (input.session && input.session.get(sessionID)?.directory !== input.directory) return
            if (pendingRequestSnapshot(current[sessionID]) !== (permissionBefore.get(sessionID) ?? "[]")) return
            const value = reconcile(
              (grouped[sessionID] ?? []).filter((request) => !!request.id).sort((a, b) => cmp(a.id, b.id)),
              { key: "id" },
            )
            if (input.session) input.session.set("permission", sessionID, value)
            if (!input.session) input.setStore("permission", sessionID, value)
          })
        })
      }

      const questions = async () => {
        const requests = await retry(async () => {
          if ((await input.protocol) === "v1") return (await input.sdk.question.list()).data ?? []
          return input.api.question.request
            .list({ location: { directory: input.directory } })
            .then((result) => result.data)
        })
        const grouped = groupBySession(
          requests.filter((request) => !!request.id && !!request.sessionID) as QuestionRequest[],
        )
        const ids = [...new Set(requests.map((request) => request.sessionID))]
        await (input.session
          ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
          : warmSessions({ ids, store: input.store, setStore: input.setStore, api: input.api.session }))

        batch(() => {
          const current = input.session?.data.question ?? input.store.question
          const sessionIDs = new Set([...Object.keys(current), ...Object.keys(grouped)])
          sessionIDs.forEach((sessionID) => {
            if (input.session && input.session.get(sessionID)?.directory !== input.directory) return
            if (pendingRequestSnapshot(current[sessionID]) !== (questionBefore.get(sessionID) ?? "[]")) return
            const value = reconcile(
              (grouped[sessionID] ?? []).filter((request) => !!request.id).sort((a, b) => cmp(a.id, b.id)),
              { key: "id" },
            )
            if (input.session) input.session.set("question", sessionID, value)
            if (!input.session) input.setStore("question", sessionID, value)
          })
        })
      }

      await Promise.all([permissions(), questions()])
    }

Replace the two inline blocks in `bootstrapDirectory` with one slow task:

    () => refreshPendingRequests(input),

- [ ] Run the focused test and App type check.

    bun test --conditions=solid --preload ./happydom.ts ./src/context/global-sync/bootstrap.test.ts
    bun typecheck

- [ ] Commit the task.

    git add packages/app/src/context/global-sync/bootstrap.ts packages/app/src/context/global-sync/bootstrap.test.ts
    git commit -m "refactor(app): reuse pending request refresh"

---

## Task 3: Recover stale sessions independently through REST

**Files:**

- Modify: `packages/app/src/context/server-sync.tsx`
- Test: `packages/app/src/context/server-sync.test.ts`
- Regression test only: `packages/app/src/context/server-session.test.ts`

- [ ] Add failing tests for stale detection and independent hydration.

Import `staleBusySessionIDs` and `hydrateRecoveredSessions`. Add these cases under the active-session tests:

1. A busy session with activity at 1,000 is not stale at 10,999 and is stale at 11,000.
2. Idle is never stale; local permission or question arrays do not suppress stale detection.
3. A session whose activity is more than one minute old and is still in the active map is force-synced and remains busy.
4. Two inactive sessions use deferred sync promises; resolving the fast one changes it to idle even while the other never resolves.
5. Calling hydration twice before the first call settles schedules only one forced sync per session.
6. A status revision change during hydration keeps the newer busy status.
7. A superseded active-check generation keeps the session busy.
8. A rejected hydration keeps the session busy without an unhandled rejection.

The independence test should use:

    const blocked = Promise.withResolvers<void>()
    const fast = Promise.withResolvers<void>()
    const inflight = new Map<string, Promise<void>>()

    hydrateRecoveredSessions({
      session: {
        status: session.status,
        sync: (sessionID, options) => {
          expect(options).toEqual({ force: true })
          return sessionID === "ses_blocked" ? blocked.promise : fast.promise
        },
      },
      active: {},
      sessionIDs: ["ses_blocked", "ses_fast"],
      observed,
      current: () => true,
      inflight,
    })

    fast.resolve()
    await fast.promise
    await Promise.resolve()

    expect(session.data.session_status.ses_blocked?.type).toBe("busy")
    expect(session.data.session_status.ses_fast?.type).toBe("idle")

- [ ] Run the focused test and confirm the helpers are missing.

    bun test --conditions=solid --preload ./happydom.ts ./src/context/server-sync.test.ts

- [ ] Add the 10-second stale selector and independent hydrator.

Place these near `reconcileActiveSessionStatuses`:

    const SESSION_RECOVERY_INTERVAL_MS = 10_000

    export function staleBusySessionIDs(session: Pick<ServerSession, "data">, now: number) {
      return Object.entries(session.data.session_status).flatMap(([sessionID, status]) => {
        if (status.type !== "busy") return []
        const activity = session.data.session_activity[sessionID] ?? status.since ?? now
        return now - activity >= SESSION_RECOVERY_INTERVAL_MS ? [sessionID] : []
      })
    }

    export function hydrateRecoveredSessions(input: {
      session: Pick<ServerSession, "status" | "sync">
      active: SessionActiveOutput
      sessionIDs: readonly string[]
      observed: ReadonlyMap<string, number>
      current: () => boolean
      inflight: Map<string, Promise<void>>
    }) {
      input.sessionIDs.forEach((sessionID) => {
        if (input.inflight.has(sessionID)) return
        const request = input.session
          .sync(sessionID, { force: true })
          .then(() => {
            if (!input.current()) return
            if (input.active[sessionID]) return
            if (input.session.status.revision(sessionID) !== input.observed.get(sessionID)) return
            input.session.status.set(sessionID, { type: "idle" })
          })
          .catch(() => undefined)
          .finally(() => {
            if (input.inflight.get(sessionID) === request) input.inflight.delete(sessionID)
          })
        input.inflight.set(sessionID, request)
      })
    }

- [ ] Replace the aggregate hydration barrier in `refreshActiveSessions`.

Import `refreshPendingRequests` from bootstrap. Add one context-local map:

    const recoveryInflight = new Map<string, Promise<void>>()

Change `refreshActiveSessions` to accept recovery targets while preserving the existing active-check generation:

    const refreshActiveSessions = async (recover: readonly string[] = []) => {
      const check = ++activeCheck
      const observed = new Map(
        Object.keys(session.data.session_status).map((sessionID) => [sessionID, session.status.revision(sessionID)]),
      )
      const result = await fetchActiveSessions()
      const active = result.active
      if (check !== activeCheck) return active

      const inactive = reconcileActiveSessionStatuses(session, active, observed, result.detailed)
      const sessionIDs = [...new Set([...inactive, ...recover])]
      refreshPendingDirectories(
        sessionIDs.flatMap((sessionID) => {
          const directory = session.get(sessionID)?.directory
          return directory ? [directory] : []
        }),
      )
      hydrateRecoveredSessions({
        session,
        active,
        sessionIDs,
        observed,
        current: () => check === activeCheck,
        inflight: recoveryInflight,
      })
      return active
    }

Delete the old active `session.resolve` loop, aggregate `Promise.allSettled`, and aggregate post-processing. Inactive sessions from ordinary startup/reconnect reconciliation remain targets; stale active sessions are added through `recover`.

- [ ] Reuse pending-request hydration for recovery and reconnect.

After the child-store manager exists, add:

    function refreshPendingDirectories(input: readonly string[]) {
      ;[...new Set(input.map(directoryKey))].forEach((directory) => {
        const child = children.children[directory]
        if (!child) return
        void refreshPendingRequests({
          directory,
          sdk: sdkFor(directory),
          api: serverSDK.api,
          store: child[0],
          setStore: child[1],
          session,
          protocol: serverSDK.protocol,
        }).catch(() => undefined)
      })
    }

In the global `server.connected` branch, keep the existing active-session refetch and also refresh requests for active child directories before the existing recent-bootstrap guard:

    if (eventType === "server.connected") {
      void activeSessionsQuery.refetch()
      refreshPendingDirectories(Object.keys(children.children).filter((directory) => children.active(directory)))
    }

Do not remove the existing full directory queue; it still refreshes the other directory data after reconnect.

- [ ] Make the watchdog connection-independent and rate-limited to one pass per ten seconds.

Keep the one-second interval because it also updates `activityNow`. Replace the current connection gate, pending-request exclusion, 45-second threshold, and 30-second throttle with:

    watchdog = setInterval(() => {
      const now = Date.now()
      setActivityNow(now)
      const stale = staleBusySessionIDs(session, now)
      if (stale.length === 0 || now - lastWatchdogCheck < SESSION_RECOVERY_INTERVAL_MS) return
      lastWatchdogCheck = now
      void refreshActiveSessions(stale)
    }, 1_000)

The existing timeline may still use its own 45-second wording for a genuinely delayed response. This task changes only synchronization recovery.

- [ ] Run focused tests, the existing message-merge regression suite, and type checking.

    bun test --conditions=solid --preload ./happydom.ts ./src/context/server-sync.test.ts
    bun test --conditions=solid --preload ./happydom.ts ./src/context/server-session.test.ts
    bun typecheck

- [ ] Commit the task.

    git add packages/app/src/context/server-sync.tsx packages/app/src/context/server-sync.test.ts
    git commit -m "fix(app): recover stale session progress"

---

## Task 4: Add the Plan-mode browser regression

**Files:**

- Modify: `packages/app/e2e/utils/sse-transport.ts`
- Modify: `packages/app/e2e/regression/session-request-docks.spec.ts`

- [ ] Add a failing option that suppresses the synthetic `server.connected` event.

Extend the transport option:

    options: { server: string; retry?: number; emitConnected?: boolean }

Pass `emitConnected` into the init script and guard both current and legacy greeting writes:

    if (emitConnected !== false && url.pathname === "/api/event") {
      controller.enqueue(
        encoder.encode(frame({ id: `evt_mock_connected_${id}`, type: "server.connected", data: {} })),
      )
    }
    if (emitConnected !== false && url.pathname === "/global/event") {
      controller.enqueue(
        encoder.encode(
          frame({
            payload: { id: `evt_mock_connected_${id}`, type: "server.connected", properties: {} },
          }),
        ),
      )
    }

The default remains `true` by testing only for `false`.

- [ ] Extend the local request-dock mock wrapper with dynamic messages and status.

Add these optional fields to the local `mockServer` input:

    pageMessages?: (sessionID: string, limit: number, before?: string) => {
      items: unknown[]
      cursor?: string
    }
    sessionStatus?: Record<string, unknown>

Forward them:

    pageMessages: requests.pageMessages ?? (() => ({ items: [] })),
    sessionStatus: requests.sessionStatus,

- [ ] Add a Plan regression whose stream opens but never emits `server.connected`.

Use a mutable status object, mutable question list, and a `completed` flag. Initial REST messages contain only the user request. After the page shows a busy turn, expose the assistant `plan_exit` result and Build question through REST without sending any SSE event:

    test("recovers a completed Plan while the event stream is still connecting", async ({ page }) => {
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
      await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
      const first = await transport.waitForConnection()
      await expectSessionTitle(page, title)
      await expect(page.getByText("Syncing status", { exact: true })).toBeVisible()

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

      const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
      await expect(page.getByText("Recovered Plan", { exact: true })).toBeVisible({ timeout: 15_000 })
      await expect(question.getByText("The plan is ready. What should happen next?")).toBeVisible()
      await expect(question.getByRole("radio", { name: /Build now/ })).toBeVisible()
      await expect(page.locator('[data-slot="session-turn-thinking"]')).toHaveCount(0)
      await expect(page.getByText("Syncing status", { exact: true })).toHaveCount(0)
      await transport.waitForConnection({ after: first.id, timeout: 5_000 })
    })

This test fails on the original behavior because the stream remains `connecting`, the watchdog refuses to run, and neither the REST Plan part nor pending question reaches the UI.

- [ ] Run E2E type checking and the focused browser test.

    bun run typecheck:e2e
    bun run test:e2e -- e2e/regression/session-request-docks.spec.ts --workers=1

- [ ] Commit the task.

    git add packages/app/e2e/utils/sse-transport.ts packages/app/e2e/regression/session-request-docks.spec.ts
    git commit -m "test(app): cover plan progress recovery"

---

## Task 5: Verify the complete change

**Files:**

- Verify all files listed in the responsibility map.

- [ ] Run the focused unit suites together.

From `packages/app`:

    bun test --conditions=solid --preload ./happydom.ts ./src/context/server-sdk.test.ts ./src/context/global-sync/bootstrap.test.ts ./src/context/server-sync.test.ts ./src/context/server-session.test.ts

- [ ] Run the complete App unit suite.

    bun run test:unit

- [ ] Run source and E2E type checking.

    bun typecheck
    bun run typecheck:e2e

- [ ] Run the focused browser regression once more.

    bun run test:e2e -- e2e/regression/session-request-docks.spec.ts --workers=1

- [ ] Inspect the final diff for generated-code edits, server changes, new dependencies, and model cancellation paths.

From the repository root:

    git status --short
    git diff --check HEAD~4..HEAD
    git diff --stat HEAD~4..HEAD

The expected diff is limited to the eight App files in the responsibility map. There must be no generated client edit, server package edit, dependency change, or call to session interruption from the recovery path.

- [ ] Confirm the acceptance behaviors from test evidence.

1. A missing `server.connected` aborts only its SSE attempt after ten seconds.
2. REST recovery runs even while connection state is `connecting`.
3. An active session can remain busy beyond one minute and is never interrupted or marked idle.
4. Persisted text, reasoning, tool state, and `plan_exit.input.plan` arrive through forced hydration.
5. An inactive session becomes idle only after successful hydration and current generation/revision checks.
6. One unresolved hydration does not delay another session.
7. V1 and V2 pending permission/question lists normalize and reconcile correctly.
8. A live pending-request event wins over an overlapping stale REST response.
9. The Plan browser regression removes the Thinking row and `Syncing status` after authoritative completion.
