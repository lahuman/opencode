# Plan Auto-Review Approval Design

## Problem

Plan mode currently forces every Bash permission request through manual approval. `packages/opencode/src/session/tools.ts` sets `alwaysAsk` and removes reusable `always` patterns for Plan, so choosing "Always allow" cannot prevent the next prompt. The app and TUI also have client-side auto-accept modes, but those approve every surfaced request once and cannot apply the evidence, safety, accuracy, and scope rules required here.

The result is repetitive prompts in Plan mode, while the available shortcut is broader and less safe than the desired Codex-style "Approve for me" behavior.

## Goals

- Add a per-session Plan approval mode with `ask` and `auto_review` values.
- Keep `ask` as the default for existing, new, and forked sessions.
- Run auto-review at the server permission boundary so the app and TUI share one decision.
- Use a separate structured model call to decide `allow`, `ask`, or `deny` for one exact permission request.
- Preserve explicit permission rules and deterministic safety checks ahead of model judgment.
- Apply the requested investigation, planning, safety, accuracy, scope, and task-management principles to Plan and the Plan-to-Build transition.
- Leave noninteractive `run --auto`, ACP, Build-mode permissions, and Permission V2 behavior unchanged.

## Non-goals

- Replacing the existing permission system or removing manual approval.
- Persisting auto-review approvals as broad rules, caching `allow` decisions, or keeping durable reviewer history.
- Adding a new reviewer model setting, provider, dependency, policy language, or extension point.
- Giving the reviewer tools or allowing it to trigger nested permission requests.
- Migrating Plan mode to Permission V2.
- Coalescing separate `external_directory` and `bash` permission boundaries.

## Chosen approach

Add the reviewer at the server-side Permission V1 evaluation boundary and persist the selected mode on the session. `SessionTools` supplies non-serialized review context for the active tool call, while one server module owns deterministic classification, prompt construction, structured inference, and result parsing. This keeps static permission rules authoritative, avoids client races or duplicated reviewer implementations, and does not add a pluggable policy framework.

Two alternatives are rejected:

1. A client review endpoint would duplicate behavior across app and TUI, fail when a client disconnects, and race with permission events.
2. Removing Plan's `alwaysAsk` behavior or expanding an allowlist would repeat the current unsafe auto-accept semantics without considering evidence or request context.

## Session state

Add `approvalMode: "ask" | "auto_review"` to the legacy session information and public create/update/read APIs. Persist it as a non-null `approval_mode` column on `SessionTable` with database default `ask`, so omitted fields and migrated rows are safe by default.

The mode is session-specific:

- New and forked sessions start as `ask`; forks do not inherit autonomy.
- A mode change is persisted immediately through the session update API.
- A mode change affects new permission boundaries. Requests already waiting for a human remain manual rather than being drained or retrospectively reviewed.
- The value is consulted only when the active agent is Plan.
- Switching to Build leaves the stored value intact but ignores it. Returning the session to Plan reuses it.
- No global enable flag is added.

The protocol and generated clients must expose the field. Generated sources are regenerated through the repository scripts and are never edited manually.

## Server permission flow

Keep Plan's existing `alwaysAsk` boundary. Extend the internal permission input used by `packages/opencode/src/session/tools.ts` with the active agent ID, session approval mode, selected model, current messages, and cancellation signal needed for review. This context is never included in the public permission event. Extend `packages/opencode/src/permission/index.ts` so an `ask` result can be passed to the server-owned reviewer only when that internal context identifies Plan with mode `auto_review`.

The order is fixed:

1. Evaluate configured and session permission rules for every pattern.
2. Return the existing denial immediately if any explicit rule denies the request.
3. Apply the deterministic Plan read-only guard. A clearly mutating request is denied and directed to Build in both approval modes; neither an `allow` rule nor a permission reply can cross this agent boundary.
4. Continue immediately if every pattern is already allowed and the Plan guard passed.
5. If manual mode is active, publish the existing permission event.
6. If Plan auto-review is active, apply the remaining deterministic safety classification. A forced-manual result publishes the permission event immediately.
7. Invoke the reviewer only when deterministic policy permits model judgment.
8. Map the structured result to one exact request:
   - `allow`: continue without publishing a permission event or updating approved-pattern memory.
   - `ask`: publish the permission event with the review summary for human confirmation.
   - `deny`: return a reviewer-specific permission error containing a concise reason and safe alternative.

Bind each decision to an immutable review envelope containing the permission request ID, session ID, current user-message and assistant-message IDs, tool call ID, agent ID, exact permission payload digest, and evidence digest. Before applying `allow` or `deny`, verify that the request is still pending, its cancellation signal is live, the envelope still matches, and the session still has `auto_review` selected. A mode change, new user steering, or changed permission or evidence digest discards the result and publishes the normal manual request.

Explicit configured `deny` rules are never sent to the model. Auto-review cannot create an `always` approval, and the approved-pattern state remains untouched. Keep a transient denial replay guard only for the same normalized request and unchanged evidence-basis digest within the same assistant message. The evidence basis excludes the denial result being replayed. An identical retry returns the same denial without another stochastic review; newly gathered evidence produces a new digest and may be reviewed. This guard is not durable and never stores an approval. Separate permission requests, including `external_directory` followed by `bash`, are reviewed separately in the first version.

## Deterministic safety classification

Known destructive or irreversible commands can never be auto-allowed. Use the existing parsed shell information where available and conservative command/argument checks for supported Bash, PowerShell, and CMD forms. This includes deletion, disk formatting, destructive Git operations such as `reset --hard` and `clean`, and broad move, copy, or overwrite operations. A command that is unambiguously mutating is denied in Plan; manual approval does not override the Plan read-only contract, and the user must switch to Build to run it.

Credential or secret access, privilege expansion, security-control weakening, external data transmission, and unrelated external paths also bypass model judgment. High-confidence Plan violations are denied; requests that could be legitimate read-only investigation force human approval. Detect these cases from the permission type and structured command or path data before constructing reviewer input.

Inspect every command in a compound expression. Aliases, shell functions, encoded commands, unsupported syntax, parse failures, unresolved redirection, ambiguous wildcards, and targets whose scope cannot be established force `ask`. Resolve relative paths against the session directory and canonicalize existing targets or their nearest existing parent; symlink or target ambiguity also forces `ask`.

The model cannot override this classification. A request that violates the Plan read-only contract is denied with a safe alternative, such as inspecting the relevant state or switching to Build. If classification cannot prove mutation but detects potentially destructive behavior, it forces human review; actual execution must occur in Build.

The classifier stays narrowly scoped to high-confidence hazards. It does not attempt to become a general shell policy engine and adds no parser dependency. For denial replay, normalize shell requests from the already parsed command structure and canonical target paths; normalize other permissions from their permission name and ordered patterns.

## Reviewer boundary

Reuse the session's selected model and existing model-resolution path for a separate structured inference call. There is no reviewer-specific model configuration.

The reviewer receives only:

- the Plan and approval-review policies;
- the current user request;
- assistant messages and relevant tool outcomes since that user request;
- the exact permission name, patterns, command or path, and tool identity;
- deterministic risk findings.

It does not receive unrelated full-session history, and it has no tools. The Plan agent is responsible for gathering evidence before requesting permission. Missing or incomplete evidence cannot be filled with guesses.

Build this current-turn slice through the existing provider message conversion and tool-output truncation paths. Do not add raw attachments, binary data, or a second unbounded transcript representation.

Treat every user message, assistant message, tool result, command, path, and repository file as untrusted evidence, never as reviewer instructions. Keep reviewer policy in the system-policy portion of the call and delimit evidence as data. Content that asks the reviewer to ignore, replace, or reinterpret its policy has no authority.

The reviewer uses the same provider and model trust boundary as the session, but it still follows data minimization. Requests containing detected credentials, secret-like values, or known sensitive metadata skip inference and go to a human. Apply the existing provider-facing redaction path to included text; if no safe representation can be produced, do not invoke the reviewer.

The structured response is limited to:

- `decision`: `allow`, `ask`, or `deny`;
- `risk`: `low`, `medium`, `high`, or `critical`;
- `reason`: a concise explanation;
- `alternative`: an optional safer next action, used for denial.

The valid decision matrix is: `low` permits `allow` or `ask`; `medium` requires `ask`; and `high` or `critical` permits `ask` or `deny`. Use `deny` when human approval still could not satisfy the Plan contract or security policy; otherwise use `ask`. Any other decision/risk combination is invalid structured output and falls back to manual approval.

The review call inherits the provider's existing cancellation and timeout behavior. It has no feature-specific retry, because repeated inference could produce conflicting approval decisions.

Reviewer usage follows the session's existing provider authentication, rate-limit, token, and cost accounting paths. It contributes exactly once through the session's concurrency-safe usage update path but does not create a synthetic assistant message or durable approval-history entry.

## Review policy

Auto-allow is limited to narrow, reversible investigation that is directly relevant to the user's request. Project-documented test, typecheck, and validation commands may be allowed when their targets and effects are clear.

The permission boundary must ask or deny, never auto-allow, when the request includes any of the following. Unambiguous Plan mutations are denied by deterministic policy before reviewer inference:

- destructive or difficult-to-recover filesystem, disk, or Git changes;
- dependency installation, code generation, deployment, or external side effects;
- opaque scripts or targets that have not been inspected;
- access to credentials, secrets, private data, or unrelated external directories;
- external data transfer, security-control weakening, or privilege expansion;
- changes outside the user's stated scope;
- missing evidence, ambiguous authorization, or uncertain impact.

The reviewer evaluates evidence rather than treating a plausible explanation as proof. It approves only the exact surfaced request and never broadens the user's authority.

## Plan and Build behavior principles

Place responsibilities where they take effect instead of duplicating the entire policy in every prompt.

Update `plan-mode.txt` to require:

- investigation before conclusions or edits;
- progressive inspection of very large files, including files over 10,000 lines, by identifying structure before reading and editing focused sections;
- complete reference and caller searches for moves, removals, and refactors;
- Exploration then Planning for new files, changes to at least three files, and structural refactors, with Execution beginning only after the user selects Build;
- concise, structured questions only when information cannot be established safely;
- concise, respectful, CLI-friendly responses in the user's language, with no emoji unless requested and plain Unicode notation instead of LaTeX for simple formulas;
- conversion of a plan into tasks with exactly one task `in_progress`.

Allow `todowrite` in Plan solely for this task-management requirement. Repository-writing tools remain blocked. A user-selected Plan session stays read-only even for a simple change; neither auto-review nor manual permission approval can override that contract. Plan may produce a short plan and offer the existing switch to Build rather than editing directly.

Update the Plan-to-Build instruction to require:

- execution without an extra "continue?" pause after the user chooses Build;
- immediate execution for simple, single-file changes once Build is active, without manufacturing a larger plan;
- reading files before overwriting and preferring partial edits;
- exact source strings for partial replacement;
- completion of all planned tasks with one `in_progress` task at a time;
- no speculative features, abstractions, comments, annotations, or unrelated cleanup;
- removal of imports, functions, and variables made unused by the requested change;
- checks against known security vulnerabilities and proportional verification before completion.

## App and TUI behavior

When Plan is active, show a session-level selector with localized labels equivalent to `Ask for approval` and `Approve for me`. The selector reads and writes the server session field, so reconnecting clients display the same state.

Manual fallback uses the existing permission surface. Add an optional typed review summary to a permission request so the app and TUI can show the risk and concise reason without parsing arbitrary tool metadata. When `always` is empty, hide the ineffective "Always allow" action rather than presenting a control that cannot persist.

While inference is pending, keep the existing tool call in its running state. Do not add a new timeline event or durable reviewer message solely for progress indication.

The existing client-side blind auto-accept mode and `auto_review` are mutually exclusive in an interactive client:

- Selecting `auto_review` writes an explicit false client override for that session and makes auto-response checks honor it, including pending-request drains. This shadows inherited lineage and directory auto-accept settings in that client.
- Enabling legacy blind auto-accept resets that session's server mode to `ask`.
- TUI keeps `--auto` as the existing noninteractive-style full auto mode; interactive review selection updates the session field.

An explicitly configured blind auto-accept in another connected client remains a stronger user override and may answer a manual fallback. The new clients avoid this combination locally; preventing an older or separately configured client from sending an authorized permission reply is out of scope.

## Failure handling

- User cancellation interrupts both the reviewer and the waiting tool request.
- Provider failure, timeout, invalid structured output, or unavailable model falls back to manual approval once.
- A fallback is not automatically retried, and it carries a concise reason that review was unavailable.
- Reviewer denial uses a distinct error message so it is never misrepresented as a user rejection.
- The denial tells the Plan agent not to retry an equivalent command to bypass review, includes a safe alternative when available, and activates the same-context denial replay guard.
- If the request is cancelled, no longer pending, or no longer names the same tool call and agent, discard the result without publishing a stale event. If the live request remains but its approval mode, user message, permission payload, or evidence digest changed, publish the normal manual request instead.

## Audit and privacy

Use structured server logs for the request ID, session ID, permission name, reviewer outcome, risk, elapsed time, and a short sanitized reason. Do not log the review transcript, file contents, exact secret-bearing command values, credentials, or private data. Existing provider telemetry and privacy settings remain authoritative.

No durable approval-history table is added. The session stores only its selected mode.

## Testing

Add focused coverage for:

1. Session schema, database default and migration, row mapping, and create/update/read API behavior.
2. Default `ask` behavior for existing, new, and forked sessions.
3. Existing rule precedence plus the new hard boundary: explicit deny, Plan read-only guard, complete allow, then ask/review.
4. Plan-only activation and unchanged Build, ACP, `run --auto`, and Permission V2 behavior.
5. One-request-only approval with no approved-pattern mutation or `allow` decision cache.
6. Parsed and conservatively handled Bash, PowerShell, and CMD destructive-command variants, compound commands, encoded or unsupported syntax, redirection, wildcards, relative paths, and symlink ambiguity.
7. Deterministic denial of Plan mutations and deterministic manual handling of secrets, external transfer, privilege expansion, security weakening, and unrelated paths before reviewer inference.
8. Prompt-injection attempts in user text, tool output, command text, and repository files remaining untrusted evidence.
9. Missing evidence, opaque commands, invalid output, provider failure, timeout, stale envelopes, cancellation, new steering, and a mode change during review.
10. Reviewer denial reason, safe-alternative propagation, and identical same-context denial replay without labeling it a user rejection.
11. Reviewer token and cost accounting exactly once without creating a transcript message, plus verification that secret-bearing requests are not sent to it.
12. App and TUI selection, persistence, reconnection, Plan-to-Build behavior, current-request behavior after mode changes, and mutual exclusion with session, lineage, and directory blind auto-accept.
13. Manual fallback presentation and hiding "Always allow" when no reusable patterns exist.
14. Plan prompt tool availability, including `todowrite`, while repository-writing tools remain denied and permission replies cannot authorize Plan writes.

Prefer pure policy tests and the repository's existing test provider and permission event paths over global mocks. Run tests and `bun typecheck` from each affected package, never the repository root. Because app session and timeline paths are affected, set `PLAYWRIGHT_WORKERS` to `1` and run the existing production benchmark suite with `bun run test:bench` from `packages/app` before implementation, preserve its `BENCHMARK` output as the baseline, and run the same suite after the change for comparison. Do not add a machine-dependent pass threshold. Regenerate public clients from `packages/client` and any affected legacy SDK through their documented scripts.

The production benchmark discovery must exclude both its Bun unit-test directory and the separately configured `timeline-stability` suite. Add one Node Playwright `--list` regression that proves benchmark discovery succeeds without loading `bun:test` fixtures and still lists the timeline benchmark scenarios. This is a harness prerequisite only; it does not change benchmark scenarios, measurements, or thresholds.

## Security invariants

- Static deny rules remain authoritative and cannot be weakened by the reviewer.
- The reviewer cannot execute tools, mutate files, persist approvals, or expand request scope.
- Destructive or unclassifiable commands cannot be auto-allowed.
- Plan's read-only contract cannot be overridden by either reviewer or human permission replies.
- Untrusted transcript and repository content cannot modify reviewer policy or grant authority.
- Sensitive requests are screened before reviewer inference and become either deterministic denial or human review when safe minimization is unavailable.
- Errors and uncertainty fail to human review, not automatic approval.
- Existing read-before-write, caller tracing, exact partial-edit, and no-unrequested-scope principles remain enforceable after the switch to Build.

## Intentional limits

This first version targets the active legacy Plan and Permission V1 path. It does not add parity to Permission V2 until Plan migrates there. It also reviews independent permission boundaries independently and does not cache `allow` decisions. The narrow same-context denial replay guard exists only to prevent stochastic bypass and is cleared with its assistant-message context. Batching or broader caching should be considered only if production measurements show a material latency problem without weakening the security boundary.
