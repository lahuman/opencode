# Task 5 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make model recovery wait for real directory refresh completion, assign replacement-toast ownership to the active prompt selection, and verify the Enterprise empty composer through the existing Playwright application fixture.

**Architecture:** Directory bootstrap status is the authoritative lifecycle boundary: every initial load or cached refresh enters `partial`, and only the latest completed refresh returns to `complete`; provider readiness additionally treats cached refetches as unavailable. Local selection silently persists recovery, while prompt selection owns user notification. Browser coverage uses the existing company-LLM E2E platform and provider tree with a deferred catalog response instead of Bun direct-run mocks.

**Tech Stack:** TypeScript, SolidJS, TanStack Solid Query, Bun test, Playwright.

## Global Constraints

- Preserve shared Task 1-4 changes and existing initial bootstrap behavior.
- Use strict RED-GREEN TDD for every production change.
- Do not add direct-run mocks, commit, or push.
- Run tests from `packages/app`; run `bun typecheck`, never `tsc`.

---

### Task 1: Directory refresh lifecycle

**Files:**

- Modify: `packages/app/src/context/global-sync/bootstrap.ts`
- Modify: `packages/app/src/context/global-sync/bootstrap.test.ts`
- Modify: `packages/app/src/context/global-sync/child-store.ts`
- Modify: `packages/app/src/context/global-sync/child-store.test.ts`

**Interfaces:**

- Consumes: existing `State.status`, TanStack query `isFetching`, directory bootstrap revision.
- Produces: authoritative `partial` during refresh and `complete` after the latest successful refresh.

- [ ] Add a cached-refresh test that starts from `complete`, defers agent/config/provider responses, asserts `partial` and stale data during the refresh, then asserts fresh data and `complete` only after all responses resolve.
- [ ] Run the focused bootstrap test and verify it fails because cached refresh remains `complete`.
- [ ] Make `bootstrapDirectory` enter `partial` for every lifecycle, await its refresh work, and guard completion with the latest directory revision.
- [ ] Run the focused bootstrap tests and verify they pass.
- [ ] Add a child-store test proving cached provider refetch makes `provider_ready` false.
- [ ] Run it RED, switch readiness from `isLoading` to `isFetching`, and run it GREEN.

### Task 2: Model recovery notification ownership

**Files:**

- Modify: `packages/app/src/context/model-selection.ts`
- Modify: `packages/app/src/context/local.tsx`
- Modify: `packages/app/src/pages/session/composer/prompt-model-selection.ts`
- Modify: `packages/app/src/pages/session/composer/prompt-model-selection.test.ts`

**Interfaces:**

- Consumes: `resolveModelRecovery` and real sync readiness.
- Produces: silent Local persistence and prompt-owned replacement notification on each independent recovery.

- [ ] Replace the coalescer test with tests that document prompt ownership and two later independent recovery plans.
- [ ] Run focused selection tests RED against the timer coalescer API.
- [ ] Remove the timer scheduler and Local toast; invoke toast directly from prompt recovery.
- [ ] Run focused selection tests GREEN and verify slash parsing/priority behavior remains intact.

### Task 3: Truthful Enterprise composer E2E

**Files:**

- Modify: `packages/app/e2e/fixtures/company-llm-enterprise.tsx`
- Modify: `packages/app/e2e/company-llm-enterprise.spec.ts`
- Modify: `packages/app/test-browser/company-llm-enterprise.test.ts`
- Modify: `packages/app/test-browser/fixtures/highlights-provider-entrypoint.ts`
- Modify: `packages/app/test-browser/solid-jsx.ts`
- Delete: `packages/app/test-browser/fixtures/company-llm-composer-entrypoint.tsx`

**Interfaces:**

- Consumes: existing Enterprise platform fixture, actual application provider tree, actual New Session composer and Settings dialog.
- Produces: deferred catalog control and Playwright assertions for loading to empty, disabled input/submit, provider settings navigation, and ordinary isolation.

- [ ] Add the Playwright assertions and fixture scenario first; run the focused spec RED because the scenario/control is absent.
- [ ] Add the minimal deferred catalog lifecycle to the existing E2E harness and mount the actual New Session route/provider tree.
- [ ] Run the focused Playwright spec GREEN.
- [ ] Remove the Task 5 direct-run composer branch, proxy entrypoint, fragment shim, and added context mocks; restore Highlights fixture behavior.
- [ ] Run affected browser and Highlights tests GREEN.

### Task 4: Verification and handoff

**Files:**

- Modify: `.superpowers/sdd/task-5-report.md`
- Regenerate: `.superpowers/sdd/task-5-review.diff`

**Interfaces:**

- Consumes: final working tree and test results.
- Produces: evidence-backed uncommitted handoff.

- [ ] Format changed Task 5 files.
- [ ] Run focused lifecycle, selection, submit, browser, Playwright, and App typecheck commands.
- [ ] Run `git diff --check`.
- [ ] Append exact RED/GREEN evidence and cleanup details to the report.
- [ ] Regenerate the review diff without committing or pushing.
