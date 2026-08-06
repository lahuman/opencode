# Plan Permission Rollback Design

## Context

Plan mode gained a session-level `ask` / `auto_review` setting, a server-side model reviewer, persisted approval state, App and TUI selectors, and review-specific permission metadata. The implementation spans 20 local commits from `f2258b78f` through `4560349f0` and is not present on `origin/enterprise-pilot`.

In `auto_review`, a Plan shell request remains a running tool while a second provider call evaluates it. The permission event is published only if that review falls back to a human. A provider call that does not settle therefore leaves the UI showing command execution without an approval request. Selecting `ask` avoids the model call, but still routes through the new Plan review state machine instead of the existing permission path.

## Decision

Remove the Plan-specific approval mode and automatic reviewer. Route Plan permission requests through the same existing Permission V1 request and reply flow as Build. Plan users choose the existing `once`, `always`, or `reject` response; `always` has the same lifetime and directory scope as Build. Keep Plan mode, the Plan-to-Build transition, Plan's tool restrictions, and the workflow principles added by `eb47196d1`.

This is a feature-boundary rollback, not a blanket revert of the 20 commits. Several commits contain unrelated or still-required changes that must be preserved.

## Preserved behavior

- Plan remains read-only by instruction and exposes only its authorized tool set.
- Plan Bash uses the normal ruleset and publishes the normal permission request when no configured or runtime approval matches.
- `once` approves only the current request.
- `always` stores the request's reusable patterns in the existing Permission instance, exactly like Build, so matching requests in the same working directory remain approved until OpenCode restarts or the instance is disposed.
- Existing configured permission denials remain authoritative.
- Build permissions, Permission V2, ACP, and noninteractive `run --auto` behavior remain unchanged.
- The Plan-to-Build confirmation card and immediate execution reminder remain unchanged.
- The investigation, planning, safety, code-quality, communication, and task-management rules in `plan-mode.txt` and `build-switch.txt` remain.
- Generic session update serialization introduced in a mixed commit remains if it is independent of `approvalMode`.

The Plan prompt must stop referring to `auto-review`. Its remaining text must describe the normal permission boundary without implying that a removed reviewer exists.

## Removed behavior and state

Remove all code whose only purpose is selecting, persisting, transporting, displaying, or executing Plan automatic review:

- `Session.ApprovalMode` and the `approvalMode` session field.
- The `approval_mode` schema definition and feature migration from the active migration set.
- Session create/update API fields and regenerated client/SDK members.
- `PlanReview`, its model prompt, provider call, review envelope, replay state, review metadata, and service dependency.
- The Plan-specific branch in `Permission.ask` and the Plan review context built by `SessionTools`.
- The Plan-only `alwaysAsk` behavior and removal of Bash reusable approval patterns.
- App and TUI approval-mode selectors, commands, mutation helpers, persistence, localization, and auto-accept mutual-exclusion logic.
- Review summaries added only for automatic-review fallback.
- Feature-specific tests, fixtures, implementation plan, and original auto-review design document.

Do not remove the existing shared permission request UI, permission reply endpoint, blind auto-accept behavior outside this feature, Plan mode, or Plan-to-Build behavior.

## Runtime data flow

After the rollback, a Plan shell request follows the Build permission path:

1. `SessionTools` resolves the normal permission rules and supplies the request's reusable approval patterns without a Plan-specific override.
2. The shell tool calls `Permission.ask` with the normal ruleset.
3. `Permission.ask` evaluates configured rules and the same directory-scoped in-memory approvals used by Build.
4. If denied, the existing denial is returned. If approval is required, the request is inserted into the pending map and `permission.asked` is published immediately.
5. The existing App or TUI permission surface displays `once`, `always` when reusable patterns exist, and `reject`.
6. `once` resolves only the current request. `always` stores the reusable patterns and resolves matching pending requests using the existing behavior. `reject` ends the request through the existing rejection behavior.

There is no reviewer provider call, hidden pre-approval state, session approval-mode lookup, or second permission state machine.

## Compatibility and migration

The feature is absent from `origin/enterprise-pilot`, so no remote Git consumer depends on its public API. Remove the field from source schemas and regenerate public clients rather than retaining an unused compatibility surface.

Do not issue a destructive down migration. A local database that already ran the feature migration may retain an unused `approval_mode` column; SQLite tolerates the extra column. New databases must no longer create it. Existing sessions must decode without an approval-mode field and use the normal permission flow.

## Git strategy

Create a new conventional rollback commit on the current branch. Do not use `git reset --hard` and do not rewrite branch history.

Use the pre-feature state at `f2258b78f^` as a reference, but apply the rollback by feature boundary so these mixed changes remain:

- `eb47196d1`: keep the Plan and Build workflow improvements; remove only `auto-review` wording and its exact assertion.
- `9e95ee750`: keep Plan's authorized tool set, `todowrite` availability, and tool-override protection; remove automatic-review wiring.
- `4560349f0`: keep generic session update serialization that is not specific to approval mode; remove approval-mode and review hardening.

Unrelated benchmark and documentation commits before `f2258b78f` remain untouched.

## Generated sources

After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Regenerate the legacy JavaScript SDK with `./packages/sdk/js/script/build.ts`. Do not edit generated client files directly.

## Verification

Run tests from their package directories, never from the repository root. Coverage must prove:

- A Plan Bash request without a matching approval publishes `permission.asked` immediately and makes zero reviewer provider calls.
- `once` allows only the current request and causes a later matching request to ask again.
- `always` stores the same reusable patterns and follows the same working-directory and restart lifetime as Build.
- `reject` ends the tool call through the shared permission path.
- Plan tool restrictions and configured denials remain intact.
- Build, ACP, Permission V2, and noninteractive behavior are unchanged.
- App and TUI no longer render or persist an approval-mode selector but still render ordinary permission requests.
- Session create, read, update, fork, import, and projection work without `approvalMode`.
- Generated clients and the legacy SDK no longer expose `approvalMode`.
- The preserved Plan and Build workflow prompt assertions still pass after removing `auto-review` wording.

Run proportional unit tests and `bun typecheck` from each affected package. Run the relevant App browser regression tests with one Playwright worker because the permission dock and session controls change.

## Acceptance criteria

- PLAN never invokes a model to approve a command.
- PLAN shows the existing permission request promptly whenever a command needs approval.
- PLAN exposes and honors the same `once` and `always` choices as BUILD.
- No `Ask for approval` / `Approve for me` mode selector remains in App or TUI.
- No approval-mode session state or public API remains.
- BUILD behavior and the preserved workflow principles remain unchanged.
- No unrelated commit or user change is reverted.
