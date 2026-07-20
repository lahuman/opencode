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

