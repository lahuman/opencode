### Task 3: Add transactional CRUD and typed Electron IPC

**Files:**
- Create: `packages/desktop/src/main/enterprise-provider-runtime.ts`
- Create: `packages/desktop/src/main/enterprise-provider-runtime.test.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/server.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/main/ipc.test.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/desktop/src/preload/types.test.ts`
- Modify: `packages/app/src/context/platform.tsx`

**Interfaces:**
- Produces this redacted renderer contract:

```ts
export type EnterpriseProviderCatalogView = EnterpriseProviderCatalog & {
  providers: Array<EnterpriseProvider & {
    credentials: {
      configured: boolean
      headerNames: string[]
      errorCode?: "credential_decryption_failed" | "credential_encryption_unavailable"
    }
  }>
}

type CredentialReplacement = { apiKey?: string; headers: Record<string, string> }
type EnterpriseProviderAPI = {
  providerCatalog(): Promise<EnterpriseProviderCatalogView>
  createProvider(input: { provider: EnterpriseProvider; credentials?: CredentialReplacement }): Promise<EnterpriseProviderCatalogView>
  updateProvider(input: { providerID: string; name: string; baseURL: string; credentials?: CredentialReplacement }): Promise<EnterpriseProviderCatalogView>
  deleteProvider(providerID: string): Promise<EnterpriseProviderCatalogView>
  createModel(input: { providerID: string; model: EnterpriseProviderModel }): Promise<EnterpriseProviderCatalogView>
  updateModel(input: { providerID: string; modelID: string; name: string }): Promise<EnterpriseProviderCatalogView>
  deleteModel(input: EnterpriseModelRef): Promise<EnterpriseProviderCatalogView>
  setDefaultModel(input: EnterpriseModelRef): Promise<EnterpriseProviderCatalogView>
  replaceProviderCredentials(input: { providerID: string; credentials: CredentialReplacement }): Promise<EnterpriseProviderCatalogView>
  clearProviderCredentials(providerID: string): Promise<EnterpriseProviderCatalogView>
}
```

- Every mutating method validates IDs and the complete candidate catalog in Electron main and resolves only after a healthy restart.

- [ ] **Step 1: Write failing runtime transaction tests**

Cover create/update/delete, immutable IDs, provider-with-zero-models, default selection, and exact fallback ordering:

```ts
test("deleting the default chooses the same provider's first remaining model", async () => {
  const runtime = createRuntime({
    catalog: {
      schemaVersion: 1,
      default: { providerID: "provider", modelID: "second" },
      providers: [{
        id: "provider",
        name: "Provider",
        baseURL: "https://provider.example/v1",
        models: [{ id: "first", name: "First" }, { id: "second", name: "Second" }],
      }],
    },
    credentials: { schemaVersion: 3, providers: { provider: { headers: {} } } },
  })
  const result = await runtime.deleteModel({ providerID: "provider", modelID: "second" })
  expect(result.default).toEqual({ providerID: "provider", modelID: "first" })
})

test("restart failure restores both stores", async () => {
  const initial = {
    catalog: {
      schemaVersion: 1 as const,
      default: { providerID: "provider", modelID: "model" },
      providers: [{
        id: "provider",
        name: "Provider",
        baseURL: "https://provider.example/v1",
        models: [{ id: "model", name: "Model" }],
      }],
    },
    credentials: { schemaVersion: 3 as const, providers: { provider: { apiKey: "secret", headers: {} } } },
  }
  const runtime = createRuntime(initial, { restart: async () => { throw new Error("restart failed") } })
  await expect(runtime.deleteProvider("provider")).rejects.toThrow("restart_failed_rolled_back")
  expect(runtime.readCatalog()).toEqual(initial.catalog)
  expect(runtime.readCredentials()).toEqual(initial.credentials)
})
```

Also assert that a second queued mutation starts only after the first restart completes, deleting a provider removes its credentials, replacing credentials is complete replacement, clearing credentials preserves metadata, and redacted views contain header names but no values.

Define `createRuntime()` in the test file as an in-memory catalog/credential store fixture. It must expose the real runtime plus `readCatalog()` and `readCredentials()` closures so rollback assertions inspect the state written by the production transaction boundary:

```ts
type TestState = { catalog: EnterpriseProviderCatalog; credentials: EnterpriseProviderCredentials }
type TestRestart = (catalog: EnterpriseProviderCatalog, credentials: EnterpriseProviderCredentials) => Promise<void>

function createRuntime(initial: TestState, overrides: { restart?: TestRestart } = {}) {
  let catalog = structuredClone(initial.catalog)
  let credentials = structuredClone(initial.credentials)
  return Object.assign(
    createEnterpriseProviderRuntime({
      catalog: { read: async () => catalog, write: async (value) => { catalog = structuredClone(value) } },
      credentials: {
        read: async () => credentials,
        write: async (value) => { credentials = structuredClone(value) },
        health: async () => ({ state: "available" as const }),
      },
      restart: overrides.restart ?? (async () => undefined),
    }),
    {
      readCatalog: () => structuredClone(catalog),
      readCredentials: () => structuredClone(credentials),
    },
  )
}
```

- [ ] **Step 2: Run runtime tests and confirm they fail**

Run from `packages/desktop`:

```powershell
bun test ./src/main/enterprise-provider-runtime.test.ts
```

Expected: FAIL because the combined runtime does not exist.

- [ ] **Step 3: Implement one serialized transactional runtime**

Use a single promise queue and one `mutate()` boundary:

```ts
const mutate = <T>(transform: (state: State) => { state: State; result: T }) => enqueue(async () => {
  const previous = await snapshot()
  const next = transform(previous)
  await persist(next.state)
  try {
    await input.restart(next.state.catalog, next.state.credentials)
  } catch {
    try {
      await persist(previous)
      await input.restart(previous.catalog, previous.credentials)
    } catch {
      throw new EnterpriseProviderRuntimeError("restart_failed_recovery_failed")
    }
    throw new EnterpriseProviderRuntimeError("restart_failed_rolled_back")
  }
  return next.result
})
```

Do not extract single-use mutation helpers. Keep catalog lookup/default-fallback helpers below the exported runtime because they name genuine validation concepts. Return `view(state)` after every mutation so the App can update without a second IPC read.

- [ ] **Step 4: Initialize the stores and pass state into every sidecar start/restart**

In `main/index.ts`, after `app.whenReady()`:

1. create the catalog and credential stores in `app.getPath("userData")`;
2. initialize/migrate them from `ENTERPRISE_PROFILE` once;
3. build the runtime with a restart callback accepting candidate catalog and credentials;
4. have ordinary startup read the same durable state and pass it to `spawnLocalServer()`;
5. update readiness/support export to summarize the default provider and redact every provider secret.

Remove the old model-scoped `enterpriseCredentialRuntime` wiring only after all callers use the new runtime.

- [ ] **Step 5: Wire explicit IPC channels and preload methods**

Use one channel per method, for example `enterprise-provider-catalog`, `enterprise-provider-create`, `enterprise-provider-update`, `enterprise-provider-delete`, `enterprise-model-create`, `enterprise-model-update`, `enterprise-model-delete`, `enterprise-model-default`, `enterprise-provider-credentials-replace`, and `enterprise-provider-credentials-clear`.

`registerIpcHandlers()` forwards raw inputs only to the runtime; the runtime performs authoritative validation. `createEnterpriseAPI()` and `mapEnterpriseAPI()` expose the exact `EnterpriseProviderAPI` names above. Remove the old model-scoped credential methods after updating all App callers.

- [ ] **Step 6: Run runtime, IPC, preload, and main entrypoint tests**

Run from `packages/desktop`:

```powershell
bun test ./src/main/enterprise-provider-runtime.test.ts ./src/main/ipc.test.ts ./src/preload/types.test.ts ./src/main/index.test.ts ./test/main-index-entrypoint.ts ./test/ipc-entrypoint.ts
```

Expected: PASS and captured IPC output contains no API key or header value.

- [ ] **Step 7: Commit the management boundary**

```powershell
git add packages/desktop/src/main/enterprise-provider-runtime.ts packages/desktop/src/main/enterprise-provider-runtime.test.ts packages/desktop/src/main/index.ts packages/desktop/src/main/server.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/ipc.test.ts packages/desktop/src/preload/types.ts packages/desktop/src/preload/types.test.ts packages/app/src/context/platform.tsx
git commit -m "feat(desktop): expose enterprise provider CRUD"
```

---

