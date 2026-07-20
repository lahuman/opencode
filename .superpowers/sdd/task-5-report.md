# Task 5 report: deleted model recovery and Enterprise empty composer

## Status

Task 5 production lifecycle and toast corrections are implemented and remain uncommitted. The focused Playwright composer transition is green; the earlier red iterations and final result are recorded below. Existing shared Task 1-4 changes were preserved.

## Files changed

- `packages/app/src/context/model-selection.ts` (new dependency-free selection helpers)
- `packages/app/src/context/local.tsx`
- `packages/app/src/pages/session/composer/prompt-model-selection.ts`
- `packages/app/src/pages/session/composer/prompt-model-selection.test.ts` (new)
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/components/prompt-input/submit.ts`
- `packages/app/src/components/prompt-input/submit.test.ts`
- `packages/app/test-browser/fixtures/highlights-provider-entrypoint.ts`
- `packages/app/test-browser/company-llm-enterprise.test.ts`

## Implementation

- Added pure `resolveModelCandidate` and `enterpriseModelState` helpers and re-exported them from the prompt selection surface.
- Both local persisted selection and prompt selection now validate every candidate in the required order: current, agent, enforced config default, recent, then connected provider default/first model.
- Enterprise-only recovery writes an invalid persisted/current pair to the replacement once, compares IDs before writing, and emits one informational replacement toast naming both pairs.
- Added a reactive Enterprise empty composer with the provider-setup placeholder, a non-editable textbox, disabled submit control, and `Manage providers` targeting Settings → Providers. Ordinary mode continues through the existing composer.
- Added a final Enterprise no-model guard in `createPromptSubmit`; it reports provider setup and returns before session creation. The ordinary missing model/agent toast remains unchanged.

## TDD evidence

### RED: selection and composer

From `packages/app` using `bun.cmd` because the `bun.ps1` shim is blocked by local PowerShell execution policy:

```powershell
bun.cmd run test:unit -- ./src/pages/session/composer/prompt-model-selection.test.ts
bun.cmd run test:browser -- ./test-browser/company-llm-enterprise.test.ts
```

- Unit RED: missing `enterpriseModelState` export (`657 pass`, Task test module error; one unrelated timeline failure also occurred because this script always includes all `./src`).
- Browser RED: expected disabled composer state but the fixture returned its normal Highlights payload. The Task browser assertion failed as intended.

### RED: final submit guard

With the guard removed and the regression present:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts -t "blocks Enterprise submission"
```

Result: `1 fail`; it received the ordinary model-required toast instead of the Enterprise provider-setup toast.

### GREEN

Fresh final targeted commands:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/prompt-input ./src/pages/session/composer/prompt-model-selection.test.ts
bun.cmd test --conditions=browser --preload ./happydom.ts ./test-browser/company-llm-enterprise.test.ts ./test-browser/highlights-enterprise.test.ts
bun.cmd typecheck
```

Results:

- Prompt/selection units: `51 pass`, `0 fail`, `148 expect()` calls.
- Enterprise browser targets: `11 pass`, `0 fail`, `19 expect()` calls.
- App typecheck: exit 0.
- Prettier completed on all Task 5 source/test files.

## Broader script results and concerns

The exact package scripts from the brief prepend their entire suite roots even when focused paths are supplied:

- `bun.cmd run test:unit -- ...`: Task tests passed, but the overall run ended `660 pass`, `1 fail` in pre-existing `src/pages/session/timeline/observe-element-offset.test.ts` (expected one offset callback, received none).
- `bun.cmd run test:browser -- ...`: both Task browser files passed, but the overall run ended `38 pass`, `2 fail` in pre-existing `test-browser/solid-virtual.test.ts` resize/clamping assertions.
- `packages/app/src/context/local.test.ts` named by the brief does not exist in this checkout.

These broader failures are outside Task 5 files and also reproduced during RED. No Task 5 targeted test or typecheck failure remains.

## Commit status

No commit or push was created, per instruction.

## Rereview correction status (2026-07-20)

Implemented the four requested corrections:

- Recovery now waits for saved/model readiness, completed sync bootstrap, and `sync().data.provider_ready` before selecting or persisting a replacement.
- Configured model parsing splits only at the first `/`, preserving slash-containing model IDs.
- Local and prompt recovery notifications share a coalescing scheduler, preventing duplicate toasts for the same replacement while allowing a later independent recovery.
- The browser fixture now mounts the real `PromptInput` under the real `PlatformProvider`, `LanguageProvider`, `DialogProvider`, and `SettingsProvider`; it exercises catalog loading/empty states and the actual Manage providers action. Direct-run-only non-target contexts are test doubles.

Fresh focused verification:

```powershell
bun.cmd test --preload ./happydom.ts ./src/pages/session/composer/prompt-model-selection.test.ts ./src/components/prompt-input/submit.test.ts
bun.cmd typecheck
bun.cmd test --conditions=browser --preload ./happydom.ts ./test-browser/company-llm-enterprise.test.ts
```

Results:

- Selection/submit units: `14 pass`, `0 fail`, `28 expect()` calls.
- App typecheck: exit 0.
- Enterprise browser file: `9 pass`, `1 fail`, `14 expect()` calls.

The remaining browser failure is fixture-only: Bun's direct-run module validation reports `Export named 'formatKeybind' not found` because the narrow `@/context/command` test double does not yet expose that named export. The spawned fixture then times out waiting for the empty composer. Per coordinator direction, work stopped rather than expanding the fixture's dependency doubles further. Production unit coverage and typecheck remain green; the real-composer browser assertion is not yet green.

## Final remediation status (2026-07-20)

- Cached directory bootstrap now sets `status` to `partial` for every refresh, uses a real agent refetch, includes provider failures in completion, and returns to `complete` only after agent, config, and provider work settles for the latest revision.
- Directory `provider_ready` now follows `!providerQuery.isFetching`, and the New Session composer model-loading state follows cached agent/provider `isFetching` activity.
- The new lifecycle regression primes a stale agent cache, defers fresh agent/config/provider responses, and proves recovery remains blocked until all three finish; it then proves the fresh agent wins over config.
- Local recovery persists silently. Only the active prompt emits the replacement toast, synchronously and once per independent recovery; the timer-based coalescer is gone.
- The direct-run composer fixture branch/proxy, generated Fragment shim, environment flag, and mocks were removed. The remaining composer coverage lives in the existing Playwright company fixture and mounts the actual `AppInterface`/New Session tree.

Fresh focused results:

```powershell
bun.cmd test --preload ./happydom.ts ./src/context/global-sync/bootstrap.test.ts ./src/context/global-sync/child-store.test.ts ./src/pages/session/composer/prompt-model-selection.test.ts ./src/components/prompt-input/submit.test.ts
bun.cmd test --conditions=browser --preload ./happydom.ts ./test-browser/company-llm-enterprise.test.ts ./test-browser/highlights-enterprise.test.ts
bun.cmd typecheck
```

- Lifecycle/selection/submit units: `24 pass`, `0 fail`, `79 expect()` calls.
- Remaining direct-run browser targets: `10 pass`, `0 fail`, `16 expect()` calls.
- App typecheck: exit 0 after correcting the new Agent fixtures (`permission: []`, `options: {}`). The subsequent fixture-only removal of the unsuccessful SSE experiment was not followed by another run, per coordinator direction.
- Cleanup grep found no `OPENCODE_TEST_EMPTY_ENTERPRISE_COMPOSER`, `ComposerHarness`, `company-llm-composer-entrypoint`, or `Fragment_8vg9x3sq` artifact.

Focused Playwright remains red:

```powershell
bun.cmd run test:e2e -- company-llm-enterprise.spec.ts -g "New Session stays editable while Enterprise providers load"
```

The latest run timed out at `page.goto` while experimenting with a real finite `server.connected` SSE refresh, so the composer assertions did not execute. That unsuccessful SSE experiment was removed rather than left in the fixture. The existing actual-App Playwright test still uses deferred global/directory provider requests and contains the loading/editor/submit/Manage providers assertions, but a fresh green run was not obtained. No full Playwright spec was run, per coordinator direction.

No commit or push was created.

## Final narrow reviewer fixes (2026-07-20)

### Awaited directory lifecycle

`bootstrapDirectory` now returns its existing slow refresh closure. Server-sync's `booting` ownership and refresh queue therefore span agent, config, provider, and the rest of the slow directory refresh.

TDD RED:

- The bootstrap promise settled while a deferred provider response was unresolved (`expected false`, received `true`).
- A refresh chained from the first promise started its config read before the first refresh completed (`expected 1`, received `2`).

GREEN: the focused bootstrap file passed `5 pass`, `0 fail`, including promise ownership, sequential ordering, cached readiness, and early status seeding while session warming remains pending.

### Session-aware toast ownership

`modelRecoveryNoticeOwner(sessionID)` assigns New Session recovery to the prompt and existing-session recovery to Local. Local persists silently when `id()` is absent; when an existing session ID is present it persists and emits the shared replacement notice. Hydrating an already-recovered selection does not produce another recovery or toast.

TDD RED was the missing ownership export. GREEN was `7 pass`, `0 fail`, including exactly one New Session notice across later hydration and exactly one existing-session Local notice.

### Reactive global provider fallback

The child-store boundary now accepts a global-provider accessor, and server-sync passes `() => globalStore.provider`. Empty directory catalogs still fall back to a non-empty global catalog, but later global query results are observed rather than reading the initial snapshot forever.

TDD RED failed at the stale value boundary (`input.global.provider.all.size`) when the regression supplied an accessor. GREEN was `7 pass`, `0 fail`, including a global full-to-empty transition.

The Playwright fixture also stopped tracking its own `storageWrites.length` inside persistence effects, removing a command-catalog write feedback loop. Deferred provider resolution now keeps the resolved empty response active for later requests in the same invalidation wave.

### Final verification

```powershell
bun.cmd test --preload ./happydom.ts ./src/context/global-sync/bootstrap.test.ts ./src/context/global-sync/child-store.test.ts ./src/pages/session/composer/prompt-model-selection.test.ts ./src/components/prompt-input/submit.test.ts
bun.cmd typecheck
```

- Affected units: `27 pass`, `0 fail`, `88 expect()` calls.
- App typecheck: exit 0.

Focused Playwright is green:

```powershell
bun.cmd run test:e2e -- company-llm-enterprise.spec.ts -g "New Session stays editable while Enterprise providers load"
```

- Result: `1 passed` in `13.5s`.
- The fixture mounts the actual `AppInterface`/New Session tree, defers both global and directory provider requests, and verifies the composer stays editable while those requests are fetching.
- A finite, schema-valid `server.connected` response triggers the real global refresh path; the event response ends immediately and the listener reconnects to a fresh pending request. The server-scoped query invalidation also marks the composer observers fetching. Resolving the deferred wave to a persistent empty fixture catalog then verifies the disabled Enterprise empty editor, disabled submit, and Manage providers dialog.
- The fixture assigns its fetch implementation to `globalThis.fetch` because loopback event transport intentionally bypasses `platform.fetch`. This assignment is isolated to the dedicated fixture page.
- The final Manage providers activation uses the spec's existing DOM-click pattern because the development diagnostics overlay can intercept Playwright pointer clicks despite the button being visible and enabled.

The temporary QueryClient/provider-count probe and the disproven `selectQueryData`/individual-query production experiment were removed. Production `useQueries` behavior is unchanged. The retained production changes are the awaited bootstrap lifecycle, session-aware recovery-notice ownership, `isFetching` readiness/loading semantics, and the reactive global-provider accessor at the child-store boundary.

No commit or push was created.
