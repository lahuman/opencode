# Skill Toggle Focus Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native skill-pack restart confirmation with a stacked application dialog and restore focus after the final settings dialog closes.

**Architecture:** The app will coordinate a Promise-backed confirmation through the existing dialog stack, preserving the parent settings dialog while the sidecar restarts. The shared UI dialog provider will use a small focus manager to remember the root dialog opener and restore it only after the complete modal stack closes.

**Tech Stack:** TypeScript, SolidJS, Kobalte Dialog, Bun test, Happy DOM

## Global Constraints

- Work on the existing `enterprise-pilot` branch; do not create a feature branch.
- Keep the Skills settings dialog open after a successful toggle.
- Do not change public Server `HttpApi`, Protocol, generated clients, Enterprise IPC, skill persistence, or sidecar rollback.
- Preserve existing localized strings and i18n parity; reuse `settings.skills.title`, `settings.skills.confirm`, `common.cancel`, and `common.continue`.
- Add each behavior through a failing test before changing production code.
- Run tests and typecheck only from package directories, never from the repository root.

---

### Task 1: Asynchronous Skill Update Admission

**Files:**
- Modify: `packages/app/src/components/settings-v2/skills.test.tsx`
- Modify: `packages/app/src/components/settings-v2/skills.tsx`

**Interfaces:**
- Consumes: the existing `updateSkillPack<T>` update, pending, completion, and failure callbacks.
- Produces: `updateSkillPack<T>` with a `confirm: () => Promise<boolean>` callback and a `Promise<boolean>` result.

- [ ] **Step 1: Write the failing asynchronous confirmation test**

Add this test to `packages/app/src/components/settings-v2/skills.test.tsx` and change the existing confirmation callbacks in that file to `async () => false` and `async () => true`:

```ts
test("waits for confirmation before entering pending state or restarting the sidecar", async () => {
  const confirmation = Promise.withResolvers<boolean>()
  const events: string[] = []
  const result = updateSkillPack({
    confirm: () => confirmation.promise,
    pending: (value) => events.push(`pending:${value}`),
    update: async () => {
      events.push("update")
      return "enabled"
    },
    complete: (value) => events.push(`complete:${value}`),
    fail: () => events.push("fail"),
  })

  await Promise.resolve()
  expect(events).toEqual([])

  confirmation.resolve(true)
  expect(await result).toBe(true)
  expect(events).toEqual(["pending:true", "update", "complete:enabled", "pending:false"])
})
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/settings-v2/skills.test.tsx
```

Expected: the new test fails because the current implementation treats the unresolved Promise as truthy and records `pending:true` before confirmation resolves.

- [ ] **Step 3: Await asynchronous confirmation in production**

Replace the confirmation type and guard in `updateSkillPack`:

```ts
export async function updateSkillPack<T>(input: {
  confirm: () => Promise<boolean>
  pending: (value: boolean) => void
  update: () => Promise<T>
  complete: (value: T) => void
  fail: (failure: unknown) => void
}) {
  if (!(await input.confirm())) return false
  input.pending(true)
  try {
    input.complete(await input.update())
    return true
  } catch (failure) {
    input.fail(failure)
    return false
  } finally {
    input.pending(false)
  }
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/settings-v2/skills.test.tsx
```

Expected: all tests in `skills.test.tsx` pass with no new warnings.

- [ ] **Step 5: Commit the asynchronous admission change**

```powershell
git add packages/app/src/components/settings-v2/skills.test.tsx packages/app/src/components/settings-v2/skills.tsx
git commit -m "fix(app): await skill restart confirmation"
```

---

### Task 2: Stacked Application Confirmation Dialog

**Files:**
- Modify: `packages/app/src/components/settings-v2/skills.test.tsx`
- Modify: `packages/app/src/components/settings-v2/skills.tsx`

**Interfaces:**
- Consumes: `useDialog().push`, `useDialog().close`, existing Skills localization keys, and `updateSkillPack` from Task 1.
- Produces: `requestSkillPackConfirmation(show): Promise<boolean>` and a feature-local `DialogSkillPackRestart` component.

- [ ] **Step 1: Write failing confirmation settlement tests**

Import `requestSkillPackConfirmation` from `./skills`, define this helper in the test file, and add the three tests below:

```ts
function confirmationHarness() {
  const state: {
    actions?: { cancel(): void; confirm(): void }
    close?: () => void
  } = {}
  const result = requestSkillPackConfirmation((actions, close) => {
    state.actions = actions
    state.close = close
  })
  return { state, result }
}

test("resolves skill restart confirmation when Continue is selected", async () => {
  const confirmation = confirmationHarness()
  confirmation.state.actions?.confirm()
  expect(await confirmation.result).toBe(true)
})

test("cancels skill restart confirmation from the Cancel action", async () => {
  const confirmation = confirmationHarness()
  confirmation.state.actions?.cancel()
  expect(await confirmation.result).toBe(false)
})

test("cancels skill restart confirmation when its dialog layer closes", async () => {
  const confirmation = confirmationHarness()
  confirmation.state.close?.()
  confirmation.state.actions?.confirm()
  expect(await confirmation.result).toBe(false)
})
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/settings-v2/skills.test.tsx
```

Expected: the test module fails because `requestSkillPackConfirmation` is not exported.

- [ ] **Step 3: Add the single-settlement confirmation coordinator**

Add this export below `SettingsSkillsV2` in `skills.tsx`:

```ts
export function requestSkillPackConfirmation(
  show: (
    actions: { cancel(): void; confirm(): void },
    close: () => void,
  ) => void,
) {
  return new Promise<boolean>((resolve) => {
    const settled = { value: false }
    const complete = (value: boolean) => {
      if (settled.value) return
      settled.value = true
      resolve(value)
    }
    show(
      {
        cancel: () => complete(false),
        confirm: () => complete(true),
      },
      () => complete(false),
    )
  })
}
```

- [ ] **Step 4: Replace `window.confirm` with a pushed application dialog**

Add imports for `ButtonV2`, `Dialog`, `DialogFooter`, `DialogHeader`, `DialogTitleGroup`, and `useDialog`. Create this feature-local component:

```tsx
function DialogSkillPackRestart(props: { name: string; cancel(): void; confirm(): void }) {
  const language = useLanguage()
  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("settings.skills.title")}
          description={language.t("settings.skills.confirm", { name: props.name })}
        />
      </DialogHeader>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={props.cancel}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="danger" onClick={props.confirm}>
          {language.t("common.continue")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
```

Inside `SettingsSkillsV2`, bind `const dialog = useDialog()` and replace the `confirm` callback passed to `updateSkillPack` with:

```tsx
confirm: () =>
  requestSkillPackConfirmation((actions, onClose) => {
    void dialog.push(
      () => (
        <DialogSkillPackRestart
          name={name}
          cancel={() => {
            actions.cancel()
            dialog.close()
          }}
          confirm={() => {
            actions.confirm()
            dialog.close()
          }}
        />
      ),
      onClose,
    )
  }),
```

This uses `push`, not `show`, so the parent settings dialog remains mounted. Escape and overlay dismissal reach the `onClose` callback and resolve as cancellation.

- [ ] **Step 5: Run the focused test and source guard**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/settings-v2/skills.test.tsx
rg -n "window\.confirm" src/components/settings-v2/skills.tsx
```

Expected: all focused tests pass and `rg` prints no match.

- [ ] **Step 6: Commit the application confirmation dialog**

```powershell
git add packages/app/src/components/settings-v2/skills.test.tsx packages/app/src/components/settings-v2/skills.tsx
git commit -m "fix(app): keep skill settings dialog active"
```

---

### Task 3: Root Dialog Focus Restoration

**Files:**
- Create: `packages/ui/src/context/dialog-focus.ts`
- Create: `packages/ui/src/context/dialog-focus.test.ts`
- Modify: `packages/ui/src/context/dialog.tsx`

**Interfaces:**
- Consumes: a current focus target accessor and a scheduler supplied by the dialog provider.
- Produces: `createDialogFocusManager(input)` with `opened(layer: number)` and `closed(remaining: number)` methods.

- [ ] **Step 1: Write failing focus-manager tests**

Create `packages/ui/src/context/dialog-focus.test.ts`:

```ts
import { expect, test } from "bun:test"
import { createDialogFocusManager } from "./dialog-focus"

function harness() {
  const target = { connected: true, focused: 0 }
  const frames: (() => void)[] = []
  const manager = createDialogFocusManager({
    active: () => ({
      get isConnected() {
        return target.connected
      },
      focus: () => target.focused++,
    }),
    schedule: (run) => frames.push(run),
  })
  return { target, frames, manager }
}

test("restores the root opener only after the final dialog layer closes", () => {
  const focus = harness()
  focus.manager.opened(0)
  focus.manager.opened(1)
  focus.manager.closed(1)
  expect(focus.frames).toHaveLength(0)

  focus.manager.closed(0)
  expect(focus.frames).toHaveLength(1)
  focus.frames[0]?.()
  expect(focus.target.focused).toBe(1)
})

test("does not focus a disconnected opener", () => {
  const focus = harness()
  focus.manager.opened(0)
  focus.manager.closed(0)
  focus.target.connected = false
  focus.frames[0]?.()
  expect(focus.target.focused).toBe(0)
})

test("does not restore an old opener when another root dialog opens first", () => {
  const focus = harness()
  focus.manager.opened(0)
  focus.manager.closed(0)
  focus.manager.opened(0)
  focus.frames[0]?.()
  expect(focus.target.focused).toBe(0)
})

test("preserves the original opener when a root dialog is replaced", () => {
  const first = { isConnected: true, focused: 0, focus() { this.focused++ } }
  const second = { isConnected: true, focused: 0, focus() { this.focused++ } }
  const state = { active: first }
  const frames: (() => void)[] = []
  const manager = createDialogFocusManager({
    active: () => state.active,
    schedule: (run) => frames.push(run),
  })

  manager.opened(0)
  state.active = second
  manager.opened(0)
  manager.closed(0)
  frames[0]?.()

  expect(first.focused).toBe(1)
  expect(second.focused).toBe(0)
})
```

- [ ] **Step 2: Run the focused UI test and verify the expected failure**

Run from `packages/ui`:

```powershell
bun test src/context/dialog-focus.test.ts
```

Expected: the test module fails because `./dialog-focus` does not exist.

- [ ] **Step 3: Implement the focus manager**

Create `packages/ui/src/context/dialog-focus.ts`:

```ts
export type DialogFocusTarget = {
  readonly isConnected: boolean
  focus(): void
}

export function createDialogFocusManager(input: {
  active(): DialogFocusTarget | undefined
  schedule(run: () => void): void
}) {
  const state: {
    generation: number
    target?: DialogFocusTarget
  } = { generation: 0 }

  return {
    opened(layer: number) {
      if (layer !== 0) return
      state.generation++
      state.target ??= input.active()
    },
    closed(remaining: number) {
      if (remaining !== 0) return
      const target = state.target
      const generation = state.generation
      state.target = undefined
      if (!target) return
      input.schedule(() => {
        if (state.generation !== generation) return
        if (!target.isConnected) return
        target.focus()
      })
    },
  }
}
```

- [ ] **Step 4: Run the focused UI test and verify it passes**

Run from `packages/ui`:

```powershell
bun test src/context/dialog-focus.test.ts
```

Expected: all four focus-manager tests pass.

- [ ] **Step 5: Integrate the manager with the dialog stack**

In `packages/ui/src/context/dialog.tsx`, import `createDialogFocusManager` and initialize it inside `init`:

```ts
const focus = createDialogFocusManager({
  active: () => (document.activeElement instanceof HTMLElement ? document.activeElement : undefined),
  schedule: (run) => requestAnimationFrame(run),
})
```

At the start of `mount`, record the layer:

```ts
focus.opened(layer)
```

In the delayed `close` callback, calculate the remaining stack once, update it, and notify the manager:

```ts
const remaining = stack().filter((item) => item.id !== closed)
current.dispose()
setStack(remaining)
focus.closed(remaining.length)
lock.value = false
```

Do not call `closed(0)` from `show`; replacing a dialog must preserve the original root opener.

- [ ] **Step 6: Run the complete UI test suite**

Run from `packages/ui`:

```powershell
bun test src --only-failures
```

Expected: all UI tests pass with zero failures.

- [ ] **Step 7: Commit dialog focus restoration**

```powershell
git add packages/ui/src/context/dialog-focus.ts packages/ui/src/context/dialog-focus.test.ts packages/ui/src/context/dialog.tsx
git commit -m "fix(ui): restore focus after dialog stack closes"
```

---

### Task 4: Package Verification and Enterprise Smoke Check

**Files:**
- Verify only; no generated files or public interfaces are expected to change.

**Interfaces:**
- Consumes: Tasks 1 through 3.
- Produces: fresh test, typecheck, diff, and manual interaction evidence.

- [ ] **Step 1: Run the focused app and UI regression tests**

Run from `packages/app`:

```powershell
bun test --preload ./happydom.ts ./src/components/settings-v2/skills.test.tsx
```

Run from `packages/ui`:

```powershell
bun test src/context/dialog-focus.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run package typechecks**

Run from each package directory:

```powershell
cd packages/app
bun typecheck
cd ../ui
bun typecheck
```

Expected: both commands exit with code 0.

- [ ] **Step 3: Inspect the final diff**

Run from the repository root:

```powershell
git diff --check
git status --short
git diff enterprise-pilot~3..enterprise-pilot -- packages/app/src/components/settings-v2 packages/ui/src/context
```

Expected: no whitespace errors, only the planned files are changed by the implementation commits, and no generated client files are present.

- [ ] **Step 4: Perform the Enterprise Desktop interaction check**

In a running Enterprise Desktop development build:

1. Open a session and focus its prompt.
2. Open Settings, select Skills, and toggle a pack.
3. Cancel the application warning and verify the toggle and sidecar remain unchanged.
4. Toggle again, choose Continue, and wait until the pending restart indicator clears.
5. Verify Settings remains open and another pack can be toggled.
6. Close Settings and type into the current prompt.
7. Confirm the text appears immediately without restarting the Desktop app.

Expected: the native browser confirmation never appears, the parent settings dialog survives the sidecar restart, and prompt input works after settings closes.

- [ ] **Step 5: Commit any verification-only test adjustment if one was required**

If verification required a test-only correction, commit only that correction with:

```powershell
git add packages/app/src/components/settings-v2/skills.test.tsx packages/ui/src/context/dialog-focus.test.ts
git commit -m "test(app): cover skill toggle focus recovery"
```

If no correction was required, do not create an empty commit.
