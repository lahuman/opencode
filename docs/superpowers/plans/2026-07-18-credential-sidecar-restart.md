# Enterprise Credential Sidecar Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Company LLM credential changes by restarting only the Enterprise sidecar, with serialized mutations and rollback recovery, so the Desktop process remains open.

**Architecture:** A new Desktop-main runtime controller wraps the existing DPAPI credential handlers. It snapshots the normalized credential map, performs one mutation, restarts the sidecar with current Skill Pack paths, and restores the previous map plus sidecar if the changed state cannot start. Existing IPC channels remain intact and report `restartRequired: false` after a successful sidecar restart.

**Tech Stack:** TypeScript, Bun test, Electron main/preload IPC, existing Enterprise credential store and sidecar lifecycle.

## Global Constraints

- Credentials remain encrypted at rest and are never added to environment variables, public Server APIs, logs, or renderer-visible responses.
- Public Protocol, Server `HttpApi`, generated clients, credential schema version `2`, and sidecar startup-message format remain unchanged.
- All credential mutations are serialized across windows.
- A failed new-state restart restores the prior credential map and attempts exactly one recovery restart.
- Successful save and clear return `{ restartRequired: false }`; other restart-capable APIs retain their existing contracts.
- Tests and type checks run from package directories, never from the repository root.

---

### Task 1: Credential Runtime Controller

**Files:**

- Create: `packages/desktop/src/main/enterprise-credential-runtime.ts`
- Create: `packages/desktop/src/main/enterprise-credential-runtime.test.ts`

**Interfaces:**

- Consumes: `EnterpriseCredentials`, existing handler methods `set()` and `clear()`, `read()`, `write()`, and `restart()` callbacks.
- Produces: `createEnterpriseCredentialRuntime(input)` with forwarded `catalog()` and `status()`, wrapped `set()` and `clear()`, and `EnterpriseCredentialRuntimeError.code` values `restart_failed_rolled_back` or `restart_failed_recovery_failed`.

- [ ] **Step 1: Write failing success and rollback tests**

Create a real temporary `createEnterpriseCredentialStore()` and `createEnterpriseCredentialHandlers()` fixture. Test that save and clear restart once and return false, then test that a failed changed-state restart restores the exact original map and performs one recovery restart.

```ts
test("restarts the sidecar without requesting a desktop restart", async () => {
  await using fixture = await runtimeFixture()
  const observed: EnterpriseCredentials[] = []
  const runtime = createEnterpriseCredentialRuntime({
    handlers: fixture.handlers,
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => observed.push(await fixture.store.all()),
  })

  await expect(runtime.set({ modelID: "code", apiKey: "new-key" })).resolves.toEqual({ restartRequired: false })
  await expect(runtime.clear("code")).resolves.toEqual({ restartRequired: false })
  expect(observed).toEqual([
    { schemaVersion: 2, models: { code: { apiKey: "new-key", headers: {} } } },
    { schemaVersion: 2, models: {} },
  ])
})

test("restores credentials and the prior sidecar when the changed state fails", async () => {
  await using fixture = await runtimeFixture()
  await fixture.store.setAll({
    schemaVersion: 2,
    models: { code: { apiKey: "old-key", headers: { Authorization: "old-header" } } },
  })
  const observed: EnterpriseCredentials[] = []
  const runtime = createEnterpriseCredentialRuntime({
    handlers: fixture.handlers,
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => {
      observed.push(await fixture.store.all())
      if (observed.length === 1) throw new Error("new state failed")
    },
  })

  await expect(runtime.set({ modelID: "code", apiKey: "new-key" })).rejects.toMatchObject({
    code: "restart_failed_rolled_back",
  })
  expect(await fixture.store.all()).toEqual(observed[1])
  expect(observed[1]?.models.code?.apiKey).toBe("old-key")
})

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "enterprise-credential-runtime-"))
  const store = createEnterpriseCredentialStore({
    file: join(root, "credentials.bin"),
    modelIDs: ["code", "reasoning"],
    defaultModelID: "code",
    encryptionAvailable: () => true,
    encrypt: (value) => Buffer.from(value, "utf8"),
    decrypt: (value) => value.toString("utf8"),
  })
  return {
    store,
    handlers: createEnterpriseCredentialHandlers(true, store, {
      defaultModelID: "code",
      models: [
        { id: "code", name: "Code", baseURL: "https://code.example/v1" },
        { id: "reasoning", name: "Reasoning", baseURL: "https://reasoning.example/v1" },
      ],
    }),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}
```

- [ ] **Step 2: Run the controller test and verify RED**

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test src/main/enterprise-credential-runtime.test.ts
```

Expected: module/import failure because `enterprise-credential-runtime.ts` does not exist.

- [ ] **Step 3: Implement the minimal serialized controller**

```ts
import type { EnterpriseCredentials } from "./enterprise-credentials"

type Handlers = {
  catalog: () => Promise<unknown>
  status: (modelID?: string) => Promise<{ configured: boolean; errorCode?: string }>
  set: (input: { modelID?: string; apiKey?: string; headers?: Record<string, string> }) => Promise<unknown>
  clear: (modelID?: string) => Promise<unknown>
}

export class EnterpriseCredentialRuntimeError extends Error {
  constructor(readonly code: "restart_failed_rolled_back" | "restart_failed_recovery_failed") {
    super(code)
    this.name = "EnterpriseCredentialRuntimeError"
  }
}

export function createEnterpriseCredentialRuntime(input: {
  handlers: Handlers
  read: () => Promise<EnterpriseCredentials>
  write: (credentials: EnterpriseCredentials) => Promise<void>
  restart: () => Promise<void>
}) {
  let mutations = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = mutations.then(operation)
    mutations = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const mutate = (operation: () => Promise<unknown>) =>
    enqueue(async () => {
      const previous = await input.read()
      await operation()
      try {
        await input.restart()
        return { restartRequired: false as const }
      } catch {
        try {
          await input.write(previous)
          await input.restart()
        } catch {
          throw new EnterpriseCredentialRuntimeError("restart_failed_recovery_failed")
        }
        throw new EnterpriseCredentialRuntimeError("restart_failed_rolled_back")
      }
    })

  return {
    catalog: input.handlers.catalog,
    status: input.handlers.status,
    set: (value: Parameters<Handlers["set"]>[0]) => mutate(() => input.handlers.set(value)),
    clear: (modelID?: string) => mutate(() => input.handlers.clear(modelID)),
  }
}
```

- [ ] **Step 4: Add recovery-failure and concurrent rollback tests**

```ts
test("reports a safe recovery failure when the restored sidecar also fails", async () => {
  await using fixture = await runtimeFixture()
  const runtime = createEnterpriseCredentialRuntime({
    handlers: fixture.handlers,
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => {
      throw new Error("restart secret detail")
    },
  })
  await expect(runtime.set({ modelID: "code", apiKey: "new-key" })).rejects.toMatchObject({
    code: "restart_failed_recovery_failed",
    message: "restart_failed_recovery_failed",
  })
})

test("serializes a later mutation behind rollback recovery", async () => {
  await using fixture = await runtimeFixture()
  await fixture.store.setAll({ schemaVersion: 2, models: { code: { apiKey: "old-key", headers: {} } } })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let restarts = 0
  const runtime = createEnterpriseCredentialRuntime({
    handlers: fixture.handlers,
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => {
      restarts++
      if (restarts !== 1) return
      entered.resolve()
      await release.promise
      throw new Error("new state failed")
    },
  })
  const first = runtime.set({ modelID: "code", apiKey: "failed-key" })
  await entered.promise
  const second = runtime.set({ modelID: "reasoning", apiKey: "reasoning-key" })
  release.resolve()

  await expect(first).rejects.toMatchObject({ code: "restart_failed_rolled_back" })
  await expect(second).resolves.toEqual({ restartRequired: false })
  expect(await fixture.store.all()).toEqual({
    schemaVersion: 2,
    models: {
      code: { apiKey: "old-key", headers: {} },
      reasoning: { apiKey: "reasoning-key", headers: {} },
    },
  })
})
```

- [ ] **Step 5: Run the controller tests and verify GREEN**

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test src/main/enterprise-credential-runtime.test.ts
```

Expected: all controller tests pass with zero failures.

---

### Task 2: Desktop Main Wiring and IPC Contract

**Files:**

- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/index.test.ts`
- Modify: `packages/desktop/test/main-index-entrypoint.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/desktop/src/preload/types.test.ts`

**Interfaces:**

- Consumes: `createEnterpriseCredentialRuntime()` from Task 1 and existing `restartEnterpriseSidecar(paths)` plus `enabledSkillPackPaths()`.
- Produces: existing `enterprise-set-credentials` and `enterprise-clear-credentials` IPC calls returning `{ restartRequired: boolean }`.

- [ ] **Step 1: Write a failing main-entrypoint integration test**

Add mode `enterprise-credential-restart` to the existing main entrypoint harness. Count `spawnLocalServer` calls and listener `stop()` calls, invoke the registered `enterprise-set-credentials` handler after startup, and print the mutation result plus counts.

```ts
test("enterprise credential save restarts only the sidecar", async () => {
  const { result } = await runMain("enterprise-credential-restart")
  expect(result).toEqual({
    mutation: { restartRequired: false },
    sidecarStarts: 2,
    sidecarStops: 1,
    relaunches: 0,
  })
})
```

Update the harness mode so Enterprise is enabled for both `enterprise` and `enterprise-credential-restart`. In the server mock, increment `sidecarStarts`; in the listener’s `stop()`, increment `sidecarStops`; in `app.relaunch()`, increment `relaunches`. For the new mode, invoke:

```ts
const mutation = await handlers.get("enterprise-set-credentials")?.({}, {
  modelID: "company-code",
  apiKey: "entrypoint-secret",
})
console.log(JSON.stringify({ mutation, sidecarStarts, sidecarStops, relaunches }))
process.exit(0)
```

- [ ] **Step 2: Run the main integration test and verify RED**

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test src/main/index.test.ts --test-name-pattern "credential save restarts only"
```

Expected: FAIL because the existing handler returns `restartRequired: true`, starts one sidecar, and stops none.

- [ ] **Step 3: Change the preload contract test to accept a non-relaunching credential result**

Use `{ restartRequired: false }` as the credential operation response in `preload/types.test.ts` while retaining `{ restartRequired: true }` for state restore.

- [ ] **Step 4: Run Desktop typecheck and verify the literal-true contract fails**

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd typecheck
```

Expected: FAIL because `restartRequired: false` is not assignable to the existing literal `true` return type.

- [ ] **Step 5: Wire the runtime controller into Electron main**

Define `enabledSkillPackPaths()` before constructing the runtime controller. Wrap the existing credential handlers as follows and expose the runtime’s methods through IPC:

```ts
const enterpriseCredentialRuntime = createEnterpriseCredentialRuntime({
  handlers: enterpriseCredentialHandlers,
  read: enterpriseCredentials.all,
  write: enterpriseCredentials.setAll,
  restart: () => restartEnterpriseSidecar(enabledSkillPackPaths()),
})
```

Use `enterpriseCredentialRuntime.catalog`, `.status`, `.set`, and `.clear` in `registerMainIpcHandlers`. Do not call `relaunch()` from this path.

- [ ] **Step 6: Widen only credential IPC/preload result types**

Change `setCredentials` and `clearCredentials` return types from `Promise<{ restartRequired: true }>` to `Promise<{ restartRequired: boolean }>`. Keep `restoreStateBackup` as literal true.

- [ ] **Step 7: Run Desktop focused tests and typecheck**

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test src/main/enterprise-credential-runtime.test.ts src/main/enterprise-credentials.test.ts src/main/index.test.ts src/preload/types.test.ts
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd typecheck
```

Expected: all focused tests pass and typecheck exits `0`.

---

### Task 3: App Non-Relaunch Regression

**Files:**

- Modify: `packages/app/src/components/dialog-company-provider.test.ts`
- Verify: `packages/app/src/components/dialog-company-provider-state.ts`
- Verify: `packages/app/src/components/dialog-company-provider.tsx`

**Interfaces:**

- Consumes: credential mutation result `{ restartRequired: boolean }`.
- Produces: no production API change; verifies false clears local secrets without invoking `platform.restart()`.

- [ ] **Step 1: Strengthen the existing false-result test**

Record `mutation`, `clearLocal`, and `restart` events and assert a false result yields exactly `['mutation', 'clearLocal']` while returning `{ restartRequired: false }`.

- [ ] **Step 2: Run the focused App test**

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test src/components/dialog-company-provider.test.ts
```

Expected: pass without production App changes; this is a compatibility characterization because the generic helper already supports false.

- [ ] **Step 3: Run App typecheck**

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd typecheck
```

Expected: exit `0`.

---

### Task 4: Verification, Commit, and Local Merge

**Files:**

- Verify all files changed by Tasks 1-3.

- [ ] **Step 1: Run final Desktop and App verification**

From `packages/desktop`:

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test src/main/enterprise-credential-runtime.test.ts src/main/enterprise-credentials.test.ts src/main/index.test.ts src/preload/types.test.ts
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd typecheck
```

From `packages/app`:

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test src/components/dialog-company-provider.test.ts
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd typecheck
```

- [ ] **Step 2: Review scope and whitespace**

```powershell
& "C:\Program Files\Git\cmd\git.exe" diff --check
& "C:\Program Files\Git\cmd\git.exe" status --short
```

Review the output and reject the change if it includes public Protocol, Server `HttpApi`, generated client, credential schema, sidecar environment, or unrelated UI files.

- [ ] **Step 3: Commit implementation**

```powershell
& "C:\Program Files\Git\cmd\git.exe" add packages/desktop packages/app/src/components/dialog-company-provider.test.ts
& "C:\Program Files\Git\cmd\git.exe" commit -m "fix(desktop): restart sidecar after credential changes"
```

- [ ] **Step 4: Merge into `enterprise-pilot` locally**

```powershell
& "C:\Program Files\Git\cmd\git.exe" switch enterprise-pilot
& "C:\Program Files\Git\cmd\git.exe" merge --no-ff credential-sidecar-restart -m "merge: restart sidecar after credential changes"
```

- [ ] **Step 5: Re-run focused Desktop tests and typecheck on the merged state**

Do not push or create a PR. Keep the feature branch unless the user explicitly requests deletion.
