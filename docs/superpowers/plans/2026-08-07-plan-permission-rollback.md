# PLAN Permission Rollback Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task. If the user selects in-session delegated execution, use `superpowers:subagent-driven-development` instead. Use `superpowers:test-driven-development` for behavior changes and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Remove PLAN-specific `ask` / `auto_review` approval modes and route PLAN through the same shared Permission V1 `once` / `always` / `reject` flow as BUILD, while preserving PLAN's read-only restrictions and unrelated hardening.

**Architecture:** `SessionTools` will give PLAN and BUILD the same resolved permission ruleset and reusable patterns. `Permission.ask` will have one pending-request path backed by the existing working-directory-scoped `InstanceState` approval cache. Session schemas, persistence, APIs, generated clients, App, TUI, and provider plumbing will no longer know about an approval mode or `PlanReview`.

**Tech Stack:** TypeScript, Bun, Effect, Drizzle/SQLite, SolidJS, OpenTUI, Playwright, generated Effect and promise clients.

**Global Constraints:**

- Work on `enterprise-pilot`; use `f2258b78f^` only as a read-only reference.
- Do not use blanket `git revert`, `git reset`, history rewriting, or a destructive database rollback.
- Read every target and inspect every symbol reference before editing; apply hunk-level patches.
- Keep `eb47196d1` workflow rules, `9e95ee750` PLAN tool restrictions/`todowrite`/override protection, and `4560349f0` generic session and shell hardening.
- Keep BUILD, Permission V2, ACP, `run --auto`, blind auto-accept, common permission UI/endpoints, and PLAN-to-BUILD behavior unchanged.
- Do not edit generated Client or legacy SDK files directly. Regenerate them from package scripts.
- Remove the feature migration from new-database history without issuing a down migration. Already-migrated local SQLite files may retain an unused column.
- Run each command with the named package as `workdir`; do not chain directory changes and commands in one shell line.
- Keep exactly one plan item `in_progress` at a time and commit each green logical slice conventionally.

---

### Task 1: Restore the shared Permission V1 runtime for PLAN

**Files:**

- Modify: `packages/opencode/test/session/tools.test.ts`
- Modify: `packages/opencode/test/permission/next.test.ts`
- Modify: `packages/opencode/src/session/tools.ts`
- Modify: `packages/opencode/src/permission/index.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Preserve/verify: `packages/opencode/src/agent/agent.ts`
- Preserve/verify: `packages/opencode/src/tool/registry.ts`
- Preserve/verify: `packages/opencode/test/agent/agent.test.ts`
- Preserve/verify: `packages/opencode/test/tool/registry.test.ts`

- [ ] **Step 1: Replace the PLAN review-wiring test with a shared-ruleset regression.**

  In `packages/opencode/test/session/tools.test.ts`, replace `loads fresh Plan authority only when the tool reaches ctx.ask` with a test that runs a PLAN Bash tool and records the permission input. It must prove the original reusable patterns and merged ruleset are passed without loading review context:

  ```ts
  expect(observed).toMatchObject({
    always: ["*"],
    ruleset: Permission.merge(agent.permission, session.permission ?? []),
  })
  expect("plan" in observed!).toBe(false)
  expect("alwaysAsk" in observed!).toBe(false)
  expect(sessionLoads).toBe(0)
  ```

  Keep existing tests for explicit PLAN Bash `allow`/`deny`, the exact authorized tool set, `todowrite`, builtin override protection, and MCP resource/tool ID collisions.

- [ ] **Step 2: Strengthen the common Permission lifecycle tests.**

  In `packages/opencode/test/permission/next.test.ts`:

  - extend `reply - once resolves the pending ask` so a later matching request becomes pending again;
  - keep `reply - always persists approval and resolves` and prove a matching request from another session in the same instance passes immediately;
  - add a separate-instance/directory case proving the same pattern asks again outside the approving working directory;
  - add a fresh-instance case proving cached `always` approval disappears after instance disposal/reload;
  - keep immediate `permission.asked`, reject/corrected errors, metadata-safe logging, and generic reply ordering tests;
  - remove `alwaysAsk`, PLAN fixtures/layers/provider counters, and every PLAN review-state test.

  The `once` continuation must contain this behavior:

  ```ts
  const again = yield* ask({
    id: PermissionV1.ID.make("per_test1_again"),
    sessionID: SessionID.make("session_test_again"),
    permission: "bash",
    patterns: ["ls"],
    metadata: {},
    always: [],
    ruleset: [],
  }).pipe(Effect.forkScoped)
  expect(yield* waitForPending(1)).toHaveLength(1)
  yield* reply({ requestID: PermissionV1.ID.make("per_test1_again"), reply: "reject" })
  expect(Exit.isFailure(yield* Fiber.await(again))).toBe(true)
  ```

- [ ] **Step 3: Run the focused tests and confirm the new PLAN expectation fails.**

  Run from `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/session/tools.test.ts test/permission/next.test.ts
  ```

  Expected: the PLAN tool test fails because `SessionTools` still supplies `plan`, clears `always`, and sets `alwaysAsk`.

- [ ] **Step 4: Collapse `SessionTools` onto the BUILD permission arm.**

  In `packages/opencode/src/session/tools.ts`, remove `PlanReview`, the PLAN-only session/message loader, reviewer seed, empty Bash `always`, and `alwaysAsk`. Keep `resolvePermissionRules`, `restrictPlanTools`, canonical `agentID`, PLAN's native Bash `ask`, configured rules, and the final hard denies.

  The single target call is:

  ```ts
  ask: (request) =>
    permission
      .ask({
        ...request,
        sessionID: input.session.id,
        tool: { messageID: input.processor.message.id, callID: options.toolCallId },
        ruleset,
      })
      .pipe(Effect.orDie),
  ```

- [ ] **Step 5: Remove the PLAN state machine from `Permission`.**

  In `packages/opencode/src/permission/index.ts`:

  - remove review ownership/replay state, `askPlan`, `alwaysAsk`, reviewer abort/finalizers, and reviewed-error branches;
  - retain the directory-scoped `InstanceState` containing `pending` and `approved`;
  - evaluate configured rules and cached approvals before asking;
  - publish `Permission.Event.Asked` immediately after inserting a pending request;
  - on `always`, append `existing.info.always` and resolve matching same-session pending requests exactly like BUILD;
  - retain metadata-safe reply logging and generic event publication ordering from later hardening.

  Remove the now-unneeded `Session.Service` provision from `packages/opencode/src/session/prompt.ts`. Leave the dormant reviewer files until Task 2 so intermediate typechecking still has every referenced module.

- [ ] **Step 6: Run focused tests and typecheck.**

  Run from `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/permission/next.test.ts test/session/tools.test.ts
  bun test --timeout 30000 test/agent/agent.test.ts test/tool/registry.test.ts
  bun typecheck
  ```

  Expected: all commands exit 0; PLAN reaches the normal pending request immediately, `once` is one-shot, and `always` has BUILD's directory/instance lifetime.

- [ ] **Step 7: Commit the runtime slice.**

  ```powershell
  git add packages/opencode
  git commit -m "fix(opencode): restore plan permission flow"
  ```

---

### Task 2: Remove the reviewer and reviewer-only permission/LLM/shell contracts

**Files:**

- Delete: `packages/opencode/src/permission/plan-review.ts`
- Delete: `packages/opencode/src/permission/plan-review.txt`
- Delete: `packages/opencode/test/permission/plan-review.test.ts`
- Delete: `packages/opencode/test/permission/plan-review-policy.test.ts`
- Modify: `packages/schema/src/v1/permission.ts`
- Modify: `packages/core/src/v1/permission.ts`
- Modify: `packages/core/test/permission.test.ts`
- Modify: `packages/opencode/src/session/llm/ai-sdk.ts`
- Modify: `packages/opencode/src/session/llm/request.ts`
- Modify: `packages/opencode/src/tool/shell.ts`
- Modify: `packages/opencode/test/provider/transform.test.ts`
- Modify: `packages/opencode/test/session/llm.test.ts`
- Modify: `packages/opencode/test/tool/shell.test.ts`

- [ ] **Step 1: Add a legacy review-metadata decoding regression.**

  In `packages/core/test/permission.test.ts`, add a case beside the Permission V1 request decoding tests:

  ```ts
  const decoded = Schema.decodeUnknownSync(PermissionV1.Request)({
    id: "per_legacy_review",
    sessionID: "ses_legacy_review",
    permission: "bash",
    patterns: ["git status"],
    metadata: {},
    always: ["git status"],
    review: { risk: "low", reason: "legacy" },
  })
  expect("review" in decoded).toBe(false)
  ```

  Remove feature-only tests for `PlanReadOnlyError` and `ReviewedDeniedError`; retain `DeniedError`, `RejectedError`, `CorrectedError`, and all Permission V2 tests.

- [ ] **Step 2: Run the focused contract test and confirm failure.**

  Run from `packages/core`:

  ```powershell
  bun test test/permission.test.ts
  ```

  Expected: the decoded request still contains `review` while the current schema declares it.

- [ ] **Step 3: Remove reviewer-only public contracts and provider preparation.**

  - Remove `ReviewRisk`, `Review`, and `Request.review` from `packages/schema/src/v1/permission.ts`.
  - Remove `PlanReadOnlyError` and `ReviewedDeniedError` from `packages/core/src/v1/permission.ts`.
  - Delete `PlanReview`, its model prompt, and its dedicated tests.
  - Remove `skipSystemTransform` and reviewer `privacy` output from `packages/opencode/src/session/llm/request.ts`; restore the normal system transform for every request.
  - Remove tests added only for reviewer privacy/model preparation.
  - Make AI SDK helpers private again when they have no remaining caller. Keep independent safe record validation and normalized `Usage.from(...)` behavior.

- [ ] **Step 4: Remove reviewer shell metadata but preserve shell safety hardening.**

  Remove `AMBIENT_ENV`, `shellName`, ambient classification, `parsed` metadata, cwd review envelope, and related reviewer tests. Preserve:

  - malformed/empty PLAN parse fallback that adds the native command as the permission pattern;
  - environment calculation before permission and reuse of that exact snapshot during execution;
  - the `reuses the environment snapshot captured before permission` regression;
  - ordinary shell permission, parsing, abort, and execution coverage;
  - removal of noisy resolved-path logging.

  The retained boundary should be equivalent to:

  ```ts
  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
  if ((tree.rootNode.hasError || scan.patterns.size === 0) && ctx.extra?.agentID === "plan") {
    scan.patterns.add(params.command)
  }
  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
  const env = yield* shellEnv(ctx, cwd)
  yield* ask(ctx, scan, params)
  return env
  ```

- [ ] **Step 5: Run focused tests and typechecks.**

  Run from `packages/core`:

  ```powershell
  bun test test/permission.test.ts
  bun typecheck
  ```

  Run from `packages/schema`:

  ```powershell
  bun test
  bun typecheck
  ```

  Run from `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/provider/transform.test.ts test/session/llm.test.ts test/tool/shell.test.ts
  bun typecheck
  ```

  Expected: all commands exit 0 and the package tree contains no `PlanReview`, review metadata, or reviewed permission errors.

- [ ] **Step 6: Commit the reviewer cleanup.**

  ```powershell
  git add packages/schema packages/core packages/opencode
  git commit -m "refactor(opencode): remove plan reviewer"
  ```

---

### Task 3: Remove the App selector while preserving the common permission dock

**Files:**

- Modify: `packages/app/src/components/prompt-input-v2.tsx`
- Modify: `packages/app/src/components/prompt-input.tsx`
- Modify: `packages/app/src/components/prompt-input/contracts.ts`
- Modify: `packages/app/src/components/prompt-input/submit.ts`
- Modify: `packages/app/src/components/prompt-input/submit.test.ts`
- Modify: `packages/app/src/components/settings-general.tsx`
- Modify: `packages/app/src/components/settings-v2/general.tsx`
- Modify: `packages/app/src/context/permission.tsx`
- Modify: `packages/app/src/context/permission-auto-respond.ts`
- Modify: `packages/app/src/context/permission-auto-respond.test.ts`
- Delete: `packages/app/src/context/permission-mutation.ts`
- Delete: `packages/app/src/context/permission-mutation.test.ts`
- Modify: `packages/app/src/pages/session.tsx`
- Modify: `packages/app/src/pages/session/composer/session-composer-controls.ts`
- Delete: `packages/app/src/pages/session/composer/session-composer-controls.test.ts`
- Modify: `packages/app/src/pages/session/composer/session-permission-dock.tsx`
- Modify: `packages/app/src/pages/session/use-session-commands.tsx`
- Delete: `packages/app/src/pages/session/use-session-commands.test.ts`
- Modify: `packages/app/src/utils/server-compat.ts`
- Modify: `packages/app/src/utils/server-compat.test.ts`
- Modify: `packages/app/src/utils/session.ts`
- Modify: `packages/app/src/utils/session.test.ts`
- Delete: `packages/app/test-browser/plan-approval-ui.test.tsx`
- Modify: `packages/app/e2e/regression/remote-session-settings.spec.ts`
- Modify: `packages/app/e2e/regression/session-request-docks.spec.ts`
- Modify: `packages/app/src/i18n/{ar,br,bs,da,de,en,es,fr,ja,ko,no,pl,ru,th,tr,uk,zh,zht}.ts`
- Modify: `packages/app/src/i18n/parity.test.ts`

- [ ] **Step 1: Rewrite App regressions around the final UI.**

  - Remove submit/control tests whose only behavior is selecting or persisting approval mode.
  - Keep `session-request-docks.spec.ts` coverage for `Allow once`, `Allow always` when patterns exist, and `Reject`.
  - Add negative checks that `Ask for approval` and `Approve for me` are absent from the composer.
  - Keep remote-settings coverage for blind auto-accept, but remove assertions that it resets an approval mode.

- [ ] **Step 2: Run focused unit tests and confirm old selector assumptions fail.**

  Run from `packages/app`:

  ```powershell
  bun test --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts ./src/context/permission-auto-respond.test.ts ./src/utils/server-compat.test.ts ./src/utils/session.test.ts ./src/i18n/parity.test.ts
  ```

- [ ] **Step 3: Remove App state, persistence, and selector rendering.**

  - Remove approval controls from prompt contracts, both prompt inputs, submit, session page, composer controls, and session commands.
  - Delete the feature-only permission mutation helper and tests.
  - Remove approval-mode mutual exclusion from blind auto-response and settings; retain ordinary blind auto-accept.
  - Remove approval compatibility/session utility branches.
  - Remove `request.review` rendering from `session-permission-dock.tsx`, but preserve `props.request.always.length > 0` around `Allow always`.
  - Remove the three `permission.approvalMode.*` keys from all 18 locales and remove their parity block.
  - Delete only the feature-only browser/component/command tests listed above.

- [ ] **Step 4: Run App verification.**

  Run from `packages/app`:

  ```powershell
  bun run test:unit
  bun run test:browser
  bun run typecheck
  bun run typecheck:e2e
  bun run test:e2e -- e2e/regression/session-request-docks.spec.ts e2e/regression/remote-session-settings.spec.ts --workers=1
  ```

  Expected: all commands exit 0; the selector is absent and the common dock still replies with `once`/`always`/`reject`.

- [ ] **Step 5: Commit the App cleanup.**

  ```powershell
  git add packages/app
  git commit -m "refactor(app): remove plan approval selector"
  ```

---

### Task 4: Remove the TUI selector while preserving ordinary permissions

**Files:**

- Modify: `packages/tui/src/app.tsx`
- Delete: `packages/tui/src/component/dialog-approval-mode.tsx`
- Modify: `packages/tui/src/component/prompt/index.tsx`
- Modify: `packages/tui/src/context/permission.tsx`
- Modify: `packages/tui/src/context/sync.tsx`
- Modify: `packages/tui/src/routes/session/permission.tsx`
- Modify: `packages/tui/test/app-lifecycle.test.tsx`
- Modify: `packages/tui/test/cli/cmd/tui/sync-fixture.tsx`
- Modify: `packages/tui/test/cli/cmd/tui/sync.test.tsx`
- Modify: `packages/tui/test/cli/tui/permission.test.tsx`
- Modify: `packages/session-ui/src/v2/components/prompt-input/index.tsx`
- Modify: `packages/session-ui/src/v2/components/prompt-input/interaction.ts`

- [ ] **Step 1: Rewrite TUI tests around the shared surface.**

  In `packages/tui/test/cli/tui/permission.test.tsx`, remove only the two review-context tests. Keep tests proving:

  - `Allow always` is hidden when `always` is empty;
  - reusable patterns stay ordered in the confirmation stage;
  - a request ID change resets the selected choice and nested stage;
  - wildcard approval says it lasts until OpenCode restarts.

  In sync tests, remove the `auto_review` session and approval-transition lock cases. Keep one simple regression proving `--auto` replies `once` without enqueuing. Retain only the args/reply-capture fixture support needed for that test.

- [ ] **Step 2: Run focused TUI tests and confirm old state dependencies fail.**

  Run from `packages/tui`:

  ```powershell
  bun test --timeout 30000 test/cli/tui/permission.test.tsx test/app-lifecycle.test.tsx test/cli/cmd/tui/sync.test.tsx
  ```

- [ ] **Step 3: Remove TUI approval-mode state and controls.**

  - Remove the dialog, command, prompt selector, optimistic session update, draft value, and auto-mode mutual exclusion.
  - Reduce the permission context to normal/auto blind-accept mode; remove `approvalMode`, `approvalPending`, and `run` because they only coordinate selector transitions.
  - Remove deferred selector-transition claims from sync; retain the direct `--auto` reply-once path.
  - Remove `request.review` from the permission route.
  - Preserve the route's `createEffect` reset, keyed request body, and `always.length > 0` condition.
  - Remove approval selector props/interactions from `session-ui`; also remove `title?`/`disabled?` interaction extensions if they have no remaining caller.

- [ ] **Step 4: Run TUI and session-ui verification.**

  Run from `packages/tui`:

  ```powershell
  bun test
  bun typecheck
  ```

  Run from `packages/session-ui`:

  ```powershell
  bun test
  bun typecheck
  ```

  Expected: all commands exit 0; ordinary permission replies and blind `--auto` remain, with no selector or review summary.

- [ ] **Step 5: Commit the TUI cleanup.**

  ```powershell
  git add packages/tui packages/session-ui
  git commit -m "refactor(tui): remove plan approval selector"
  ```

---

### Task 5: Remove approval mode from session schemas, storage, and APIs

**Files:**

- Modify: `packages/schema/src/session.ts`
- Modify: `packages/schema/src/v1/session.ts`
- Delete: `packages/schema/test/session-approval-mode.test.ts`
- Modify: `packages/core/src/session.ts`
- Modify: `packages/core/src/session/info.ts`
- Modify: `packages/core/src/session/projector.ts`
- Modify: `packages/core/src/session/sql.ts`
- Delete: `packages/core/src/database/migration/20260805063214_plan_approval_mode.ts`
- Modify by generator/reference: `packages/core/schema.json`
- Modify by generator: `packages/core/src/database/migration.gen.ts`
- Modify by generator: `packages/core/src/database/schema.gen.ts`
- Modify: `packages/core/test/database-migration.test.ts`
- Modify: `packages/core/test/session-create.test.ts`
- Modify: `packages/core/test/session-projector.test.ts`
- Modify: `packages/opencode/src/session/session.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- Preserve: `packages/opencode/src/cli/cmd/import.ts`
- Modify: `packages/opencode/test/server/httpapi-session.test.ts`
- Modify: `packages/opencode/test/session/schema-decoding.test.ts`
- Modify: `packages/opencode/test/session/session-schema.test.ts`
- Modify: `packages/opencode/test/session/session.test.ts`
- Preserve/verify: `packages/opencode/test/cli/import.test.ts`
- Preserve/verify: `packages/opencode/test/cli/run/run-process.test.ts`
- Modify: `packages/protocol/src/groups/session.ts`
- Modify: `packages/server/src/handlers/session.ts`

- [ ] **Step 1: Rewrite session regressions around the field-free contract.**

  Update schema/core/opencode fixtures for create, read, patch, projection, fork, import, and decoding to omit `approvalMode`. Add a compatibility case that strips a legacy extra field:

  ```ts
  const decoded = Schema.decodeUnknownSync(SessionV1.SessionInfo)({
    ...sessionFixture,
    approvalMode: "auto_review",
  })
  expect("approvalMode" in decoded).toBe(false)
  ```

  In `packages/opencode/test/session/session.test.ts`, rewrite the approval-mode-plus-permission concurrency test as a generic metadata-plus-permission patch race so `KeyedMutex` coverage remains.

  In core tests:

  - assert new-database `session` columns omit `approval_mode` and active migration IDs omit `20260805063214_plan_approval_mode`;
  - keep the two usage accumulation/stale-update projector tests;
  - keep the `SessionInputTable` empty-state assertion.

- [ ] **Step 2: Run focused tests and confirm field-free assertions fail.**

  Run from `packages/core`:

  ```powershell
  bun test test/database-migration.test.ts test/session-create.test.ts test/session-projector.test.ts
  ```

  Run from `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/session/session.test.ts test/session/session-schema.test.ts test/session/schema-decoding.test.ts test/server/httpapi-session.test.ts
  ```

- [ ] **Step 3: Remove approval mode end to end while preserving mixed hardening.**

  - Remove `Session.ApprovalMode`, every `approvalMode` field/default/create input, and the feature-only schema test.
  - Remove `approval_mode` from Drizzle tables, row conversion, projection, and persistence.
  - Remove `SetApprovalModeInput`, `setApprovalMode`, create/fork/update propagation, HTTP fields/handlers, protocol fields, and server payload handling.
  - Preserve `packages/core/src/session/projector.ts` `sessionRowWithoutUsage`, `addUsage`, and `time_updated` protection so Session Updated events cannot reset accumulated usage.
  - Preserve `packages/opencode/src/session/session.ts` `KeyedMutex`, `toRow(info: Schema.Schema.Type<typeof Info>)`, and defensive clones of `summary_diffs`, `metadata`, and `permission`.
  - Preserve the removed import cast in `packages/opencode/src/cli/cmd/import.ts`; do not reintroduce `as Session.Info`.

- [ ] **Step 4: Regenerate core migration artifacts without creating a down migration.**

  Delete the feature migration and selectively restore `packages/core/schema.json` to its `f2258b78f^` state after removing the source column. Then run from `packages/core`:

  ```powershell
  bun script/migration.ts
  ```

  Inspect the migration directory immediately. Expected: no new migration file; only `migration.gen.ts` and `schema.gen.ts` are regenerated. If a drop-column migration appears, stop, remove only that newly generated file, restore the snapshot correctly, and rerun.

  Then run:

  ```powershell
  bun script/migration.ts --check
  ```

  Expected: exit 0. No existing SQLite database is opened or altered.

- [ ] **Step 5: Run package tests and typechecks.**

  Run from `packages/schema`:

  ```powershell
  bun test
  bun typecheck
  ```

  Run from `packages/core`:

  ```powershell
  bun test test/database-migration.test.ts test/session-create.test.ts test/session-projector.test.ts test/permission.test.ts
  bun typecheck
  ```

  Run `bun typecheck` separately from `packages/protocol` and `packages/server`.

  Run from `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/session/session.test.ts test/session/session-schema.test.ts test/session/schema-decoding.test.ts
  bun test --timeout 30000 test/server/httpapi-session.test.ts test/cli/import.test.ts
  bun test --timeout 30000 test/acp/permission.test.ts test/cli/run/run-process.test.ts
  bun typecheck
  ```

  Expected: all commands exit 0; session APIs no longer contain approval state, while import, ACP, and noninteractive behavior remain green.

- [ ] **Step 6: Commit the session/API removal.**

  ```powershell
  git add packages/schema packages/core packages/protocol packages/server packages/opencode
  git commit -m "refactor(core): remove plan approval mode"
  ```

---

### Task 6: Regenerate public clients and the legacy JavaScript SDK

**Files:**

- Modify by generator: `packages/client/src/generated/client.ts`
- Modify by generator: `packages/client/src/generated/types.ts`
- Modify by generator: `packages/client/src/generated-effect/client.ts`
- Modify: `packages/client/test/promise.test.ts`
- Modify by generator: `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- Modify by generator: `packages/sdk/js/src/v2/gen/types.gen.ts`

- [ ] **Step 1: Remove approval-mode expectations from the promise client test.**

  Keep session create/get/update coverage, but remove request bodies and response assertions for `approvalMode`. Assert serialized session results do not expose that key.

- [ ] **Step 2: Regenerate both clients.**

  Run from `packages/client`:

  ```powershell
  bun run generate
  ```

  Run from `packages/sdk/js`:

  ```powershell
  bun run build
  ```

  These are the required package-local forms of `bun run generate` and `./packages/sdk/js/script/build.ts`. Do not hand-edit generated files.

- [ ] **Step 3: Inspect and test generated output.**

  Confirm the generated diff removes only review metadata and approval-mode session/API members. Run from `packages/client`:

  ```powershell
  bun test test/promise.test.ts
  bun typecheck
  ```

  Run from `packages/sdk/js`:

  ```powershell
  bun test
  bun typecheck
  ```

- [ ] **Step 4: Commit generated output.**

  ```powershell
  git add packages/client packages/sdk/js
  git commit -m "chore(sdk): regenerate session types"
  ```

- [ ] **Step 5: Verify generation is reproducible after the generated diff is committed.**

  Run from `packages/client`:

  ```powershell
  bun run check:generated
  ```

  Expected: exit 0 and no new worktree diff. This check intentionally runs after the generated commit because it compares generated files to `HEAD`.

---

### Task 7: Remove obsolete auto-review wording and feature documents

**Files:**

- Modify: `packages/opencode/src/session/prompt/plan-mode.txt`
- Preserve: `packages/opencode/src/session/prompt/build-switch.txt`
- Modify: `packages/opencode/test/session/instruction.test.ts`
- Delete: `docs/superpowers/specs/2026-08-05-plan-auto-review-design.md`
- Delete: `docs/superpowers/plans/2026-08-05-plan-auto-review.md`
- Preserve: `docs/superpowers/specs/2026-08-06-plan-permission-rollback-design.md`
- Preserve: `docs/superpowers/plans/2026-08-07-plan-permission-rollback.md`
- Preserve: `packages/web/src/content/docs/permissions.mdx`

- [ ] **Step 1: Change the prompt assertion first.**

  ```ts
  expect(prompt).toContain("Permission approval does not change Plan's read-only operating mode.")
  expect(prompt).not.toContain("auto-review")
  ```

- [ ] **Step 2: Run the prompt test and confirm failure.**

  Run from `packages/opencode`:

  ```powershell
  bun test test/session/instruction.test.ts
  ```

- [ ] **Step 3: Replace only obsolete wording and remove old feature docs.**

  In `plan-mode.txt`, replace the auto-review sentence with `Permission approval does not change Plan's read-only operating mode.` Keep all investigation, planning, safety, quality, interaction, and task-management rules. Do not alter `build-switch.txt`.

  Delete only the original auto-review design and implementation plan. Keep the approved rollback design and this plan. Keep the web `--auto` documentation because it describes the separate noninteractive/blind auto-accept feature.

- [ ] **Step 4: Verify prompts.**

  Run from `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/session/instruction.test.ts test/session/tools.test.ts
  bun test --timeout 30000 test/agent/agent.test.ts test/tool/registry.test.ts
  ```

- [ ] **Step 5: Commit documentation cleanup.**

  ```powershell
  git add packages/opencode/src/session/prompt packages/opencode/test/session/instruction.test.ts docs/superpowers
  git commit -m "docs(opencode): remove plan auto-review"
  ```

---

### Task 8: Run full verification and preservation audit

**Files:**

- Verify all changed files; modify only when a failing check identifies a defect within this rollback.

- [ ] **Step 1: Verify generated and migration artifacts.**

  Run from `packages/core`:

  ```powershell
  bun script/migration.ts --check
  ```

  Run from `packages/client`:

  ```powershell
  bun run check:generated
  ```

  Expected: both exit 0 and create no worktree changes.

- [ ] **Step 2: Run affected package suites and typechecks.**

  From `packages/schema`:

  ```powershell
  bun test
  bun typecheck
  ```

  From `packages/core`, `packages/client`, `packages/sdk/js`, `packages/opencode`, `packages/session-ui`, and `packages/tui`, run each package's full `bun test` and `bun typecheck` separately. From `packages/protocol` and `packages/server`, run `bun typecheck`.

  From `packages/app`:

  ```powershell
  bun run test:unit
  bun run test:browser
  bun run typecheck
  bun run typecheck:e2e
  bun run test:e2e -- e2e/regression/session-request-docks.spec.ts e2e/regression/remote-session-settings.spec.ts --workers=1
  ```

  Expected: every command exits 0. If an unrelated pre-existing failure appears, record the exact command/output, prove it outside this diff, and do not broaden the rollback.

- [ ] **Step 3: Audit preserved mixed-commit behavior.**

  Confirm with source inspection and focused tests:

  - PLAN Bash still defaults to `ask`; user rules apply after native defaults; edit/execute/lsp/skill/task remain hard denied; `todowrite` remains allowed.
  - PLAN uses authorized builtins and rejects custom/MCP overrides while BUILD custom tools still work.
  - malformed/empty PLAN shell parsing still creates a native-command permission pattern.
  - shell execution reuses the exact environment snapshot approved by the user.
  - core Session Updated projection still preserves accumulated usage and rejects stale overwrite.
  - OpenCode session patching still uses `KeyedMutex`, safe inferred typing, and defensive clones.
  - App/TUI still hide `always` without reusable patterns and reset state on a new request.
  - BUILD, ACP, Permission V2, `run --auto`, blind auto-accept, and PLAN-to-BUILD tests remain green.
  - `plan-mode.txt` and `build-switch.txt` retain the approved workflow rules.

- [ ] **Step 4: Scan for removed feature residue.**

  Run from the repository root:

  ```powershell
  rg -n -i "approvalMode|approval_mode|auto_review|planreview|plan-review|alwaysAsk|PlanReadOnly|ReviewedDenied|request\.review|permission\.approvalMode|prompt-approval-mode|permission\.approval_mode|Approve for me" packages
  rg -n -i "auto-review|auto_review|plan-review|Approve for me" docs --glob "!superpowers/specs/2026-08-06-plan-permission-rollback-design.md" --glob "!superpowers/plans/2026-08-07-plan-permission-rollback.md"
  git diff --check
  git status --short
  git diff --stat origin/enterprise-pilot...HEAD
  ```

  Expected: both residue scans return no matches; no whitespace errors or untracked build artifacts exist; the diff contains only the selective rollback plus previously committed local work.

- [ ] **Step 5: Review commit scope and report completion.**

  Review `git log --oneline origin/enterprise-pilot..HEAD` without squashing or rewriting. Report:

  - the removed stall path and why `permission.asked` is now immediate;
  - PLAN `once`/`always` directory and restart lifetime;
  - deleted mode/reviewer/storage/API/UI surfaces;
  - preserved mixed hardening;
  - exact generation, test, typecheck, and one-worker E2E results;
  - the harmless unused `approval_mode` column note for already-migrated local SQLite files.
