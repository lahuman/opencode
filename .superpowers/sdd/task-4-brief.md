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

