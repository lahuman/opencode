# Initial Prompt Single-Submit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit the first prompt exactly once, clear the composer before asynchronous session creation, and restore the captured draft safely when creation fails.

**Architecture:** Keep a synchronous in-flight guard inside each `createPromptSubmit` instance and release it from `finally`. Reuse `createPromptSubmissionState` as the prompt snapshot boundary, teaching it to preserve an already-cleared state when the submission is retargeted from the project composer to the newly created session composer.

**Tech Stack:** TypeScript, SolidJS prompt state, Bun test runner, Happy DOM.

## Global Constraints

- Keep the change inside `packages/app`; do not change Protocol, Server, or generated clients.
- Clear the composer only after prompt, model, and agent validation succeeds.
- Ignore additional submits while the first admission is pending.
- Release the guard after every success or failure.
- Restore a failed captured prompt only when doing so will not overwrite newer input.
- Do not change established-session queue semantics.
- Run tests and `bun typecheck` from `packages/app`, never from the repository root.

---

### Task 1: Preserve cleared state across prompt retargeting

**Files:**
- Create: `packages/app/src/components/prompt-input/submission-state.test.ts`
- Modify: `packages/app/src/components/prompt-input/submission-state.ts`

**Interfaces:**
- Consumes: `createPromptState({ prompt?: string })` from `@/context/prompt` and `createPromptSubmissionState({ target, prompt, context })`.
- Produces: unchanged `createPromptSubmissionState` API; after `clear()` followed by `retarget(next)`, `next.current()` is the default empty prompt while captured context is still copied to `next.context`.

- [ ] **Step 1: Write the failing retarget regression test**

Create `packages/app/src/components/prompt-input/submission-state.test.ts`:

```ts
import { expect, test } from "bun:test"
import { createPromptState, DEFAULT_PROMPT } from "@/context/prompt"
import { createPromptSubmissionState } from "./submission-state"

test("keeps the destination composer clear when retargeting a cleared submission", () => {
  const initial = createPromptState({ prompt: "first prompt" })
  const destination = createPromptState({ prompt: "stale destination draft" })
  const submission = createPromptSubmissionState({
    target: initial.capture(),
    prompt: initial.current(),
    context: [],
  })

  submission.clear()
  submission.retarget(destination.capture())

  expect(initial.current()).toEqual(DEFAULT_PROMPT)
  expect(destination.current()).toEqual(DEFAULT_PROMPT)
})
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/prompt-input/submission-state.test.ts
```

Expected: FAIL because the destination still contains `stale destination draft` after `retarget()`.

- [ ] **Step 3: Reset a retargeted destination when the submission was already cleared**

Update the `retarget` method in `packages/app/src/components/prompt-input/submission-state.ts`:

```ts
    retarget(next: PromptTarget) {
      input.context.forEach(next.context.add)
      target = next
      if (cleared === undefined) return
      target.reset()
      cleared = target.current()
    },
```

This keeps the existing context transfer. Updating `cleared` to the destination's post-reset prompt also preserves the existing non-destructive `restore()` comparison.

- [ ] **Step 4: Run the focused test and verify it passes**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/prompt-input/submission-state.test.ts
```

Expected: PASS with one test.

- [ ] **Step 5: Commit the prompt state transition**

```powershell
git add packages/app/src/components/prompt-input/submission-state.ts packages/app/src/components/prompt-input/submission-state.test.ts
git commit -m "test(app): cover cleared prompt retargeting"
```

---

### Task 2: Clear and coalesce the initial prompt submission

**Files:**
- Modify: `packages/app/src/components/prompt-input/submit.test.ts`
- Modify: `packages/app/src/components/prompt-input/submit.ts`

**Interfaces:**
- Consumes: the cleared-retarget behavior from Task 1 and the existing `PromptSubmitInput` callbacks.
- Produces: unchanged `{ abort, handleSubmit }` return API. `handleSubmit(event)` synchronously claims a per-instance guard, clears valid input before the first asynchronous creation call, ignores concurrent calls, and releases the guard in `finally`.

- [ ] **Step 1: Add controllable session failure support to the test client**

In `packages/app/src/components/prompt-input/submit.test.ts`, import `createPromptState` and `DEFAULT_PROMPT`, declare the failure switch, apply it after the existing creation gate, and reset it in `beforeEach`:

```ts
import { createPromptState, DEFAULT_PROMPT, type Prompt, type PromptStore } from "@/context/prompt"

let createSessionFailure: Error | undefined
```

```ts
      create: async () => {
        await createSessionGate
        if (createSessionFailure) throw createSessionFailure
        createdSessions.push(directory)
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
```

```ts
  createSessionFailure = undefined
```

- [ ] **Step 2: Add failing tests for immediate clearing, coalescing, failure restoration, and retry**

Add these tests to the existing `describe("prompt submit worktree selection", ...)` block. They use the real in-memory prompt state rather than changing the shared legacy fixture:

```ts
  test("clears and admits a repeated initial submission only once", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = createPromptState({ prompt: "ls" })
    const submit = createPromptSubmit({
      prompt: current,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })
    const event = { preventDefault: () => undefined } as unknown as Event

    const first = submit.handleSubmit(event)
    const second = submit.handleSubmit(event)
    const third = submit.handleSubmit(event)

    expect(current.current()).toEqual(DEFAULT_PROMPT)
    release()
    await Promise.all([first, second, third])

    expect(createdSessions).toEqual(["/repo/worktree-a"])
    expect(sentShell).toEqual(["/repo/worktree-a"])
    expect(promoted).toEqual([{ directory: "/repo/worktree-a", sessionID: "session-1" }])
  })

  test("restores a failed initial prompt and permits retry", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    createSessionFailure = new Error("session create failed")
    const current = createPromptState({ prompt: "ls" })
    const submit = createPromptSubmit({
      prompt: current,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })
    const event = { preventDefault: () => undefined } as unknown as Event

    const first = submit.handleSubmit(event)
    expect(current.current()).toEqual(DEFAULT_PROMPT)

    release()
    await first
    expect(current.current()).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])

    createSessionGate = undefined
    createSessionFailure = undefined
    await submit.handleSubmit(event)

    expect(createdSessions).toEqual(["/repo/worktree-a"])
    expect(sentShell).toEqual(["/repo/worktree-a"])
  })

  test("does not overwrite a newer prompt when initial session creation fails", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    createSessionFailure = new Error("session create failed")
    const current = createPromptState({ prompt: "ls" })
    const submit = createPromptSubmit({
      prompt: current,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })
    const event = { preventDefault: () => undefined } as unknown as Event

    const first = submit.handleSubmit(event)
    expect(current.current()).toEqual(DEFAULT_PROMPT)
    current.set([{ type: "text", content: "next", start: 0, end: 4 }], 4)

    release()
    await first

    expect(current.current()).toEqual([{ type: "text", content: "next", start: 0, end: 4 }])
  })
```

- [ ] **Step 3: Run the submit tests and verify the expected failures**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts
```

Expected: all three new tests fail at their immediate-clear assertion because the current implementation leaves `ls` visible while session creation is pending. The repeated-submit test would also create multiple sessions if allowed to continue; clearing, coalescing, restoration, retry, and non-destructive failure behavior are covered before production changes are accepted.

- [ ] **Step 4: Add the per-instance in-flight guard**

In `createPromptSubmit`, rename the current `handleSubmit` implementation to `submit`, remove its `event.preventDefault()` line, and keep its capture-through-send body unchanged. Then add the public guarded event boundary immediately below it:

```ts
  let submitting = false

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    if (submitting) return
    submitting = true
    await submit().finally(() => {
      submitting = false
    })
  }
```

The `submit` extraction names the asynchronous admission boundary and keeps the guard's `finally` small. Do not add a module-global guard or share it between composer instances.

- [ ] **Step 5: Move optimistic clear and restoration before asynchronous creation**

Inside `submit`, keep prompt/model/agent validation first. Immediately after validation and history bookkeeping, define the existing clear/restore closures and call `clearInput()` before reading worktree/session creation results:

```ts
    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    clearInput()
```

Remove the later duplicate definitions and later unconditional `clearInput()` calls in the queue, shell, custom-command, and normal-prompt branches. Keep context cleanup in its existing branch-specific locations.

Before each early return caused by worktree or session creation failure, restore the prompt:

```ts
        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          restoreInput()
          return
        }
```

```ts
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      restoreInput()
      return
    }
```

Retain the existing shell, custom-command, and normal-prompt catch handlers; they continue to call `restoreInput()` and remain protected by the same non-destructive state comparison.

- [ ] **Step 6: Run focused tests and fix only guard/clear regressions**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/prompt-input/submission-state.test.ts ./src/components/prompt-input/submit.test.ts
```

Expected: PASS for both files with no failures or unhandled errors.

- [ ] **Step 7: Run the app package unit suite and typecheck**

Run from `packages/app`:

```powershell
bun run test:unit
bun typecheck
```

Expected: both commands exit 0. If an unrelated pre-existing failure appears, record the exact failing test or diagnostic separately and keep the focused regression tests green.

- [ ] **Step 8: Commit the behavior change**

```powershell
git add packages/app/src/components/prompt-input/submit.ts packages/app/src/components/prompt-input/submit.test.ts
git commit -m "fix(app): prevent duplicate initial prompt submissions"
```
