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

