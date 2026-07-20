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

