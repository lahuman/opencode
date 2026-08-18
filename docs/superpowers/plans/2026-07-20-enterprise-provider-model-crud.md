# Enterprise Provider and Model CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let SFMI Enterprise users manage a Windows-user-global catalog of OpenAI-compatible providers and models, including provider-scoped secrets and a selectable default model.

**Architecture:** Electron main owns a schema-versioned non-secret catalog and a DPAPI-encrypted provider credential store. Catalog mutations run through one transactional runtime that restarts the sidecar with the candidate catalog and credentials, rolling both stores back on failure; the sidecar materializes and enforces only the Electron-owned catalog after project config merging.

**Tech Stack:** TypeScript, Bun tests, Electron IPC and `safeStorage`, SolidJS, TanStack Solid Query/resources, Playwright, OpenCode Enterprise config/provider layers.

## Global Constraints

- Apply only to SFMI Enterprise; ordinary OpenCode behavior must remain unchanged.
- Support only `@ai-sdk/openai-compatible` providers.
- Accept absolute HTTP(S) Base URLs without credentials, query, or fragment; continue blocking redirects.
- Catalog data is Windows-user-global and shared by all projects.
- Credentials are provider-scoped and encrypted with Windows DPAPI.
- Provider and model IDs are immutable after creation.
- Do not change public Protocol, Server `HttpApi`, or generated SDKs.
- Run tests and `bun typecheck` from package directories, never from the repository root.

---

### Task 1: Add the durable provider catalog and migrate provider-scoped credentials

**Files:**
- Create: `packages/desktop/src/main/enterprise-providers.ts`
- Create: `packages/desktop/src/main/enterprise-providers.test.ts`
- Modify: `packages/desktop/src/main/enterprise-credentials.ts`
- Modify: `packages/desktop/src/main/enterprise-credentials.test.ts`

**Interfaces:**
- Produces:

```ts
export type EnterpriseModelRef = { providerID: string; modelID: string }
export type EnterpriseProviderModel = { id: string; name: string }
export type EnterpriseProvider = {
  id: string
  name: string
  baseURL: string
  models: EnterpriseProviderModel[]
}
export type EnterpriseProviderCatalog = {
  schemaVersion: 1
  default?: EnterpriseModelRef
  providers: EnterpriseProvider[]
}
export type EnterpriseProviderCredentials = {
  schemaVersion: 3
  providers: Record<string, { apiKey?: string; headers: Record<string, string> }>
}
```

- Produces `createEnterpriseProviderStore(input)` with `read()`, `write(catalog)`, `initialize(profile, legacyCredentials)`, and `clear()`.
- Produces `createEnterpriseCredentialStore(input)` with `read()`, `write(credentials)`, `health()`, `clear()`, and `readLegacy()`; catalog membership validation belongs to the transactional runtime, not the encrypted file decoder.

- [ ] **Step 1: Write failing catalog validation, seeding, and migration tests**

Add tests that establish the exact durable shape and preserve every legacy endpoint/secret:

```ts
test("seeds one provider per packaged legacy model", async () => {
  const initialized = await store.initialize(
    {
      defaultModelID: "code",
      models: [
        { id: "code", name: "Code", baseURL: "https://code.example/v1" },
        { id: "reasoning", name: "Reasoning", baseURL: "https://reasoning.example/v1" },
      ],
    },
    {
      schemaVersion: 2,
      models: {
        code: { apiKey: "code-key", headers: {} },
        reasoning: { headers: { "X-Token": "reasoning-token" } },
      },
    },
  )

  expect(initialized.catalog).toEqual({
    schemaVersion: 1,
    default: { providerID: "company-llm", modelID: "code" },
    providers: [
      { id: "company-llm", name: "Code", baseURL: "https://code.example/v1", models: [{ id: "code", name: "Code" }] },
      {
        id: "company-llm-2",
        name: "Reasoning",
        baseURL: "https://reasoning.example/v1",
        models: [{ id: "reasoning", name: "Reasoning" }],
      },
    ],
  })
  expect(initialized.credentials).toEqual({
    schemaVersion: 3,
    providers: {
      "company-llm": { apiKey: "code-key", headers: {} },
      "company-llm-2": { headers: { "X-Token": "reasoning-token" } },
    },
  })
})

test("rejects invalid URLs and dangling defaults", async () => {
  expect(() => validateEnterpriseProviderCatalog({
    schemaVersion: 1,
    default: { providerID: "missing", modelID: "model" },
    providers: [{ id: "provider", name: "Provider", baseURL: "https://user:pass@example.com/v1", models: [] }],
  })).toThrow()
})
```

Also cover duplicate provider IDs, duplicate model IDs within a provider, empty names, query/fragment URLs, empty catalogs, atomic temp-file cleanup, corrupt JSON, and stable `company-llm-N` collision handling.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run from `packages/desktop`:

```powershell
bun test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts
```

Expected: FAIL because the provider catalog types/store and credential schema v3 do not exist.

- [ ] **Step 3: Implement the catalog schema, validator, atomic store, and migration**

Keep validation synchronous and persistence in the store boundary. The validator must normalize URL serialization while preserving IDs and names:

```ts
const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

export function validateEnterpriseProviderCatalog(value: unknown): EnterpriseProviderCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.providers)) {
    throw new Error("Enterprise provider catalog is invalid")
  }
  const providerIDs = new Set<string>()
  const providers = value.providers.map((item) => {
    if (!isRecord(item) || !Array.isArray(item.models)) throw new Error("Enterprise provider is invalid")
    const id = requireProviderID(item.id)
    if (providerIDs.has(id)) throw new Error("Enterprise provider ID is duplicated")
    providerIDs.add(id)
    const modelIDs = new Set<string>()
    const models = item.models.map((model) => {
      if (!isRecord(model)) throw new Error("Enterprise model is invalid")
      const modelID = requireText(model.id, "Enterprise model ID is required")
      if (modelIDs.has(modelID)) throw new Error("Enterprise model ID is duplicated")
      modelIDs.add(modelID)
      return { id: modelID, name: requireText(model.name, "Enterprise model name is required") }
    })
    return {
      id,
      name: requireText(item.name, "Enterprise provider name is required"),
      baseURL: requireBaseURL(item.baseURL),
      models,
    }
  })
  const defaultModel = decodeDefault(value.default, providers)
  return { schemaVersion: 1, ...(defaultModel ? { default: defaultModel } : {}), providers }
}
```

Implement writes with `${file}.tmp`, `writeFile(..., { mode: 0o600 })`, `rename`, and `finally(() => rm(temp, { force: true }))`. `initialize()` must return existing valid state unchanged; only a missing catalog invokes the one-provider-per-legacy-model migration.

Refactor the encrypted credential decoder to accept both schema v2 and v3, return tagged legacy data from `readLegacy()`, and persist only schema v3 after initialization. Do not expose decrypted data outside Electron main/runtime tests.

- [ ] **Step 4: Run focused persistence tests**

Run:

```powershell
bun test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts
```

Expected: PASS with no plaintext secret appearing in the non-secret catalog fixture.

- [ ] **Step 5: Commit the persistence boundary**

```powershell
git add packages/desktop/src/main/enterprise-providers.ts packages/desktop/src/main/enterprise-providers.test.ts packages/desktop/src/main/enterprise-credentials.ts packages/desktop/src/main/enterprise-credentials.test.ts
git commit -m "feat(desktop): persist enterprise provider catalog"
```

---

### Task 2: Materialize the runtime catalog and provider-scoped credentials in the sidecar

**Files:**
- Modify: `packages/desktop/src/main/sidecar-startup.ts`
- Modify: `packages/desktop/src/main/sidecar.ts`
- Modify: `packages/desktop/src/main/server.ts`
- Modify: `packages/desktop/src/main/sidecar-startup.test.ts`
- Modify: `packages/opencode/src/config/enterprise.ts`
- Modify: `packages/opencode/src/provider/enterprise.ts`
- Modify: `packages/opencode/test/config/enterprise.test.ts`
- Modify: `packages/opencode/test/provider/enterprise.test.ts`

**Interfaces:**
- Consumes `EnterpriseProviderCatalog` and `EnterpriseProviderCredentials` from Task 1.
- Sidecar start payload adds `catalog?: EnterpriseProviderCatalog` alongside `credentials?: EnterpriseProviderCredentials`.
- `ConfigEnterprise.settings()` returns `catalog`, `defaultModel`, and the existing offline/default/guide fields.
- `ProviderEnterprise.options(providerID, modelID, current)` reads credentials from `credentials.providers[providerID]`.

- [ ] **Step 1: Write failing Enterprise config and credential routing tests**

Add an authoritative-catalog test proving project config cannot replace an endpoint:

```ts
test("enterprise enforcement rebuilds registered providers from the runtime catalog", () => {
  const policy = {
    enabled: true,
    defaultsPath: undefined,
    guidePath: undefined,
    skillPaths: [],
    allowedOrigins: new Set<string>(),
    catalog: {
      schemaVersion: 1 as const,
      default: { providerID: "internal", modelID: "code" },
      providers: [{ id: "internal", name: "Internal", baseURL: "https://arbitrary.example/v1", models: [{ id: "code", name: "Code" }] }],
    },
  }
  const result = ConfigEnterprise.enforce({
    provider: {
      internal: { npm: "other-package", options: { baseURL: "https://attacker.example/v1" }, models: { code: { name: "Changed" } } },
      injected: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://injected.example/v1" }, models: { model: {} } },
    },
  }, policy)

  expect(Object.keys(result.provider ?? {})).toEqual(["internal"])
  expect(result.provider?.internal.npm).toBe("@ai-sdk/openai-compatible")
  expect(result.provider?.internal.options?.baseURL).toBe("https://arbitrary.example/v1")
})
```

Add provider credential tests showing every model under one provider receives the same API key/headers, another provider does not, and credential headers replace same-name configured headers case-insensitively.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run from `packages/opencode`:

```powershell
bun test ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts
```

Expected: FAIL because Enterprise settings still consume the build-time model list and credentials are keyed by model ID.

- [ ] **Step 3: Pass the catalog through the sidecar command without exposing it to project config**

Extend the start input structurally:

```ts
type StartInput = {
  hostname: string
  port: number
  password: string
  userDataPath: string
  catalog?: EnterpriseProviderCatalog
  credentials?: EnterpriseProviderCredentials
}
```

`postSidecarStartCommand()` must transfer both owned values, post once, then set both `owner.catalog` and `owner.credentials` and both command properties to `undefined`. In `sidecar.ts`, serialize the validated catalog into `process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG` before importing `virtual:opencode-server`, then call `ProviderEnterprise.setCredentials(command.credentials)` and clear the command fields.

- [ ] **Step 4: Replace build-time model materialization with catalog materialization and exact enforcement**

Parse `OPENCODE_ENTERPRISE_PROVIDER_CATALOG` only in Enterprise mode. Empty catalogs are valid and produce no default model:

```ts
export function materializeDefaults(info: Info, policy: Policy = settings()): Info {
  if (!policy.enabled) return info
  return {
    ...info,
    ...(info.model ? {} : policy.catalog.default ? { model: `${policy.catalog.default.providerID}/${policy.catalog.default.modelID}` } : {}),
    provider: {
      ...info.provider,
      ...Object.fromEntries(policy.catalog.providers.map((provider) => [provider.id, {
        npm: OPENAI_COMPATIBLE,
        name: provider.name,
        options: { baseURL: provider.baseURL },
        models: Object.fromEntries(provider.models.map((model) => [model.id, { name: model.name }])),
      }])),
    },
  }
}
```

`enforce()` must iterate the authoritative catalog instead of trusting merged provider keys. It may retain non-secret model capability/options fields from the matching merged model, but it must overwrite provider ID, name, npm package, Base URL, model IDs, model names, and model provider package/API. An empty catalog returns `provider: {}`, `enabled_providers: []`, and preserves the existing offline plugin/share/autoupdate gates.

Update `ProviderEnterprise.options()` to resolve `currentCredentials.providers[providerID]`; keep the manual-redirect fetch wrapper unchanged.

- [ ] **Step 5: Run sidecar and OpenCode tests**

Run from `packages/desktop`:

```powershell
bun test ./src/main/sidecar-startup.test.ts ./src/main/enterprise-sidecar-env.test.ts
```

Run from `packages/opencode`:

```powershell
bun test ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts ./test/provider/header-timeout.test.ts
```

Expected: PASS; ordinary non-Enterprise test cases retain their existing providers and model resolution.

- [ ] **Step 6: Commit the sidecar runtime contract**

```powershell
git add packages/desktop/src/main/sidecar-startup.ts packages/desktop/src/main/sidecar.ts packages/desktop/src/main/server.ts packages/desktop/src/main/sidecar-startup.test.ts packages/opencode/src/config/enterprise.ts packages/opencode/src/provider/enterprise.ts packages/opencode/test/config/enterprise.test.ts packages/opencode/test/provider/enterprise.test.ts
git commit -m "feat(opencode): load enterprise provider catalog"
```

---

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

### Task 4: Replace Company LLM credentials UI with provider and model management

**Files:**
- Modify: `packages/app/src/components/dialog-company-provider-state.ts`
- Modify: `packages/app/src/components/dialog-company-provider.test.ts`
- Modify: `packages/app/src/components/dialog-company-provider.tsx`
- Modify: `packages/app/src/components/settings-providers.tsx`
- Modify: `packages/app/src/components/settings-v2/providers.tsx`
- Modify: `packages/app/src/components/settings-v2/settings-v2.css`
- Modify: `packages/app/e2e/fixtures/company-llm-enterprise.tsx`
- Modify: `packages/app/e2e/company-llm-enterprise.spec.ts`

**Interfaces:**
- Consumes `platform.enterprise.providerCatalog()` and every CRUD method from Task 3.
- Produces pure form validation and fallback presentation helpers in `dialog-company-provider-state.ts`.
- The renderer never stores or receives API key/header values; credentials use `preserve`, `replace`, or `clear` intent.

- [ ] **Step 1: Write failing pure UI-state tests**

Replace model-scoped catalog merge tests with provider-form tests:

```ts
test("provider update preserves immutable IDs", () => {
  const result = validateEnterpriseProviderForm({
    mode: { type: "edit", providerID: "internal" },
    providerID: "internal",
    name: "Internal Updated",
    baseURL: "https://new.example/v1",
    models: [{ id: "code", name: "Code Updated" }],
    existingProviderIDs: new Set(["internal"]),
  })
  expect(result).toMatchObject({ providerID: "internal", name: "Internal Updated" })
})

test("credential replacement sends a complete set", () => {
  expect(providerCredentialIntent("replace", " key ", [
    { key: "X-Token", value: " value " },
  ])).toEqual({ mode: "replace", credentials: { apiKey: "key", headers: { "X-Token": "value" } } })
})
```

Cover provider/model duplicate validation, invalid URLs, zero models, disabled Test connection without a model, case-insensitive duplicate headers, default badges, pending action locking, and delete-confirmation state.

- [ ] **Step 2: Run App unit tests and confirm they fail**

Run from `packages/app`:

```powershell
bun run test:unit -- ./src/components/dialog-company-provider.test.ts
```

Expected: FAIL because the current component supports only model-scoped credentials.

- [ ] **Step 3: Implement the provider list and editor**

Keep `DialogCompanyProvider` as the large management dialog and make its top-level state read as the happy path:

```ts
const [catalog, catalogActions] = createResource(
  () => platform.enterprise,
  (enterprise) => enterprise?.providerCatalog(),
)
const [state, setState] = createStore({
  selectedProviderID: "",
  editor: undefined as "create" | "edit" | undefined,
  action: undefined as ProviderAction,
  confirm: undefined as { type: "provider" | "model"; providerID: string; modelID?: string } | undefined,
  error: undefined as string | undefined,
})
```

The list shows provider name, Base URL, model count, redacted credential state, and default model. The editor exposes ID/name/Base URL, nested model ID/name rows, and credential intent. IDs are editable only while creating. Providers with zero models save successfully; Set default and Test connection remain disabled.

Use returned catalog views to call `catalogActions.mutate(result)` after successful IPC mutations rather than waiting for a second read. Clear plaintext form state on provider selection, dialog close, successful replacement, and error recovery.

- [ ] **Step 4: Implement destructive confirmations and diagnostics**

Provider deletion confirmation text must state that models and credentials are removed. Model deletion confirmation states that history remains. Execute only the stored confirmed ID; do not close over a mutable selection.

Connection testing calls:

```ts
serverSDK().client.provider.diagnose({
  providerID: selectedProvider.id,
  modelID: selectedModel.id,
  checkToolCall: true,
})
```

Retain the existing diagnostic check/status rendering but label it with the selected provider/model rather than `Company LLM`.

- [ ] **Step 5: Update both settings layouts**

Replace the single Company LLM summary with:

- provider count and current default `Provider / Model`;
- `Manage providers` opening `DialogCompanyProvider`;
- `Test connection` targeting the default pair and disabled when no default exists.

Keep ordinary non-Enterprise provider settings byte-for-byte behaviorally unchanged.

- [ ] **Step 6: Update the Enterprise fixture and Playwright CRUD coverage**

The fixture's fake Enterprise API must own a mutable in-memory catalog and implement every Task 3 method. Add flows that assert:

1. create provider with arbitrary `https://gateway.example/v1` URL;
2. add two models and set the second default;
3. replace credentials without rendering secret values back into the DOM;
4. edit name/Base URL while IDs stay disabled;
5. diagnose the selected provider/model;
6. delete the default model and observe same-provider fallback;
7. delete the provider and observe the empty state.

- [ ] **Step 7: Run App unit and focused E2E tests**

Run from `packages/app`:

```powershell
bun run test:unit -- ./src/components/dialog-company-provider.test.ts
bun run typecheck:e2e
bun run test:e2e -- ./e2e/company-llm-enterprise.spec.ts
```

Expected: PASS at desktop and compact viewport sizes with no secret value in snapshots or Playwright traces.

- [ ] **Step 8: Commit the settings experience**

```powershell
git add packages/app/src/components/dialog-company-provider-state.ts packages/app/src/components/dialog-company-provider.test.ts packages/app/src/components/dialog-company-provider.tsx packages/app/src/components/settings-providers.tsx packages/app/src/components/settings-v2/providers.tsx packages/app/src/components/settings-v2/settings-v2.css packages/app/e2e/fixtures/company-llm-enterprise.tsx packages/app/e2e/company-llm-enterprise.spec.ts
git commit -m "feat(app): manage enterprise providers and models"
```

---

### Task 5: Handle deleted selections and disable chat for an empty catalog

**Files:**
- Modify: `packages/app/src/context/local.tsx`
- Modify: `packages/app/src/pages/session/composer/prompt-model-selection.ts`
- Modify: `packages/app/src/pages/session/composer/prompt-model-selection.test.ts`
- Modify: `packages/app/src/components/prompt-input.tsx`
- Modify: `packages/app/src/components/prompt-input/submit.ts`
- Modify: `packages/app/test-browser/fixtures/highlights-provider-entrypoint.ts`
- Modify: `packages/app/test-browser/company-llm-enterprise.test.ts`

**Interfaces:**
- Consumes the provider list refreshed after sidecar restart and the default model surfaced by enforced config.
- Produces a resolved selection state distinguishing `loading`, `available`, and Enterprise `empty`.
- Produces pure `resolveModelCandidate(candidates, valid)` and `enterpriseModelState({ enterprise, loading, model })` helpers for deterministic selection tests.

- [ ] **Step 1: Write failing stale-selection and empty-catalog tests**

Add tests proving a removed current model resolves to the configured/default remaining model:

```ts
test("falls back when the current enterprise model was deleted", () => {
  const valid = (model: ModelKey) => model.providerID === "remaining" && model.modelID === "code"
  expect(resolveModelCandidate([
    { providerID: "deleted", modelID: "old" },
    { providerID: "remaining", modelID: "code" },
  ], valid)).toEqual({ providerID: "remaining", modelID: "code" })
})

test("reports enterprise empty state when no model exists", () => {
  expect(enterpriseModelState({ enterprise: true, loading: false, model: undefined })).toBe("empty")
})
```

Add a browser test that the composer is disabled and the Manage providers action opens settings when the fake catalog is empty.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run from `packages/app`:

```powershell
bun run test:unit -- ./src/pages/session/composer/prompt-model-selection.test.ts
bun run test:browser -- ./test-browser/company-llm-enterprise.test.ts
```

Expected: FAIL because the selection API does not expose an Enterprise empty state or settings action.

- [ ] **Step 3: Centralize valid fallback resolution**

In both local and composer selection paths, resolve in this order while filtering every candidate through the current connected provider/model map:

1. current prompt/session selection;
2. agent model;
3. enforced configured default;
4. recent valid model;
5. first connected provider default/first model.

When the previous current pair disappears and a fallback exists, set the fallback once and show one informational toast naming the deleted selection and replacement. Avoid an effect loop by comparing provider/model IDs before setting.

- [ ] **Step 4: Add the Enterprise empty composer state**

When `platform.enterprise` exists, provider loading is complete, and selection has no model:

- make the editor and submit control non-interactive;
- replace the normal placeholder with `Add a provider and model to start chatting`;
- render a `Manage providers` button that opens Settings → Providers;
- keep ordinary OpenCode's existing model-required toast behavior unchanged.

`submit.ts` remains the final guard: if Enterprise is empty, show the provider-setup message and return before creating a session.

- [ ] **Step 5: Run selection, browser, and existing prompt tests**

Run from `packages/app`:

```powershell
bun run test:unit -- ./src/pages/session/composer/prompt-model-selection.test.ts ./src/context/local.test.ts ./src/components/prompt-input
bun run test:browser -- ./test-browser/company-llm-enterprise.test.ts ./test-browser/highlights-enterprise.test.ts
```

Expected: PASS; a deleted selection changes once, and an empty Enterprise catalog cannot submit a prompt.

- [ ] **Step 6: Commit selection recovery**

```powershell
git add packages/app/src/context/local.tsx packages/app/src/pages/session/composer/prompt-model-selection.ts packages/app/src/pages/session/composer/prompt-model-selection.test.ts packages/app/src/components/prompt-input.tsx packages/app/src/components/prompt-input/submit.ts packages/app/test-browser/fixtures/highlights-provider-entrypoint.ts packages/app/test-browser/company-llm-enterprise.test.ts
git commit -m "fix(app): recover deleted enterprise models"
```

---

### Task 6: Run cross-package verification and Enterprise build checks

**Files:**
- Modify only if a test exposes an implementation defect in Tasks 1-5.

**Interfaces:**
- Verifies all previously produced interfaces; introduces no new API.

- [ ] **Step 1: Run Desktop tests and type checking**

From `packages/desktop`:

```powershell
bun test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts ./src/main/enterprise-provider-runtime.test.ts ./src/main/sidecar-startup.test.ts ./src/main/ipc.test.ts ./src/preload/types.test.ts ./src/main/index.test.ts
bun typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 2: Run OpenCode Enterprise/provider tests and type checking**

From `packages/opencode`:

```powershell
bun test ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts ./test/provider/header-timeout.test.ts ./test/provider/diagnostic.test.ts
bun typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 3: Run App unit, browser, E2E typecheck, and focused Playwright tests**

From `packages/app`:

```powershell
bun run test:unit
bun run test:browser
bun typecheck
bun run typecheck:e2e
bun run test:e2e -- ./e2e/company-llm-enterprise.spec.ts
```

Expected: all tests PASS, type checks exit 0, and Playwright records no failed desktop/compact scenario.

- [ ] **Step 4: Build the Enterprise Desktop application**

From `packages/desktop`:

```powershell
bun run build
```

Expected: Electron Vite builds main, preload, and renderer bundles successfully with the Enterprise environment supplied by the existing prebuild hook.

- [ ] **Step 5: Inspect the final diff and secret boundary**

From the repository root:

```powershell
git diff --check origin/dev...HEAD
git diff --name-only origin/dev...HEAD
rg -n "apiKey|headers" packages/desktop/src/preload packages/app/src/components/dialog-company-provider.tsx
```

Expected: no whitespace errors; public renderer/preload response types contain only `configured`, `headerNames`, and error codes, never secret values.
