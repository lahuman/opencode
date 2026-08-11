# Plan Read-Only Git Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove generic Bash and direct Shell execution from Plan while preserving safe repository analysis through a built-in tool that compares any two commits as a summary first and one exact file patch second.

**Architecture:** Keep Plan safety structural: both Plan tool filters exclude `bash`, the backend rejects `session.shell` for the canonical `plan` agent, and the App removes every Plan Shell entry point. Add three narrowly scoped read-only operations to the existing `Git.Service`; expose them through one `git_diff` built-in that resolves revisions to immutable commit IDs, emits a sorted summary without patches, and accepts one literal repository-relative path for a follow-up patch. Build keeps Bash and also receives `git_diff` through normal built-in registration.

**Tech Stack:** TypeScript, Effect, Bun, Git CLI argument arrays, SolidJS, Bun test, Playwright.

## Global constraints

- Implement the approved design in `docs/superpowers/specs/2026-08-11-plan-git-diff-design.md`; do not broaden `git_diff` into status, log, show, apply, checkout, fetch, or working-tree inspection.
- Do not implement a Bash command allowlist or rely on permission rules to remove Bash. The two structural Plan tool filters and the direct-shell backend guard are the authorities.
- Do not change the existing working-tree `Git.diff`, `Git.stats`, or `Git.patch` behavior. Add separate commit-to-commit operations.
- Reuse `Git.Service.run`; its existing Git prefix already applies `--no-optional-locks`. Do not bypass or remove that prefix.
- Do not invoke a command shell from `git_diff`, accept free-form Git options, request permission, inspect the current filesystem to decide whether a historical file exists, or fall back to Bash.
- Resolve `base` and `target` once, use only the returned full object IDs for every comparison, return those IDs in metadata, and instruct follow-up calls to reuse them.
- Use real temporary Git repositories for Git behavior tests. Configured helper and partial-clone tests must exercise Git itself, not a mocked Git service.
- Keep the public Protocol and Server `HttpApi` shapes unchanged. The existing shell endpoint already declares a 400 response, so do not regenerate clients or SDKs.
- Run tests and `bun typecheck` from the owning package directory, never from the repository root. Do not run `tsc` directly.
- Begin implementation from a clean worktree containing this committed plan document.
- Keep changes scoped to this feature; do not refactor unrelated Git, prompt, permission, or composer code.

---

## Task 1: Add read-only commit comparison primitives

**Files:**

- Modify: `packages/opencode/src/git/index.ts:31-90, 228-342`
- Modify: `packages/opencode/test/git/git.test.ts`

**Interfaces:**

```ts
export type ChangedFile = {
  readonly file: string
  readonly status: Kind
  readonly additions: number
  readonly deletions: number
}

export interface Interface {
  // Existing members remain unchanged.
  readonly resolveCommit: (cwd: string, revision: string) => Effect.Effect<string | undefined>
  readonly changedFiles: (cwd: string, base: string, target: string) => Effect.Effect<ChangedFile[], Error>
  readonly patchBetween: (cwd: string, base: string, target: string, file: string) => Effect.Effect<string, Error>
}
```

- [ ] **Step 1: Write revision-resolution tests before adding the API.**

  In `test/git/git.test.ts`, build a real repository with at least three commits, a branch, and an annotated tag. Add `resolveCommit() resolves commit revision forms`, asserting that a full ID, an unambiguous abbreviation, the branch, the tag, and `HEAD~1` all return their full commit IDs. Add `resolveCommit() rejects non-commits and option-shaped revisions`, asserting that a tree expression, a missing name, and `--output=owned` return `undefined` and do not create `owned`.

- [ ] **Step 2: Write summary and exact-patch tests.**

  Add `changedFiles() returns a sorted two-commit summary` with added, modified, deleted, binary, and renamed content. Assert:

  - output uses the deterministic ordinal comparator specified in Step 5, not locale-dependent sorting;
  - rename detection is disabled, so a rename appears as delete plus add;
  - binary `-` counts become zero;
  - the working tree and untracked files do not affect the result;
  - identical commits return `[]`.

  Add `patchBetween() treats pathspec syntax literally` using both `file[1].txt` and `file1.txt`. Assert the first path's patch contains only `file[1].txt`, while an unchanged path returns an empty string.

- [ ] **Step 3: Write configured-helper and partial-clone tests.**

  For `patchBetween() disables external diff and textconv helpers`, configure both `diff.external` and a `.gitattributes` textconv driver to a Bun script that writes a marker file and exits. Assert a normal patch is returned and the marker is absent.

  For `read-only comparisons do not lazily fetch missing objects`:

  1. create a real bare `file://` remote and enable `uploadpack.allowFilter=true`;
  2. clone with `--filter=blob:none --no-checkout` so a changed blob remains absent;
  3. call `patchBetween()` and assert failure;
  4. run `git cat-file -e` with `GIT_NO_LAZY_FETCH=1` and assert the blob is still absent;
  5. create a remote commit after cloning, write its ID to a remote-tracking ref in the partial clone without copying the object, call `resolveCommit()` for that ref, and assert it returns `undefined` while the commit object remains absent.

  This proves both revision resolution and diff generation avoid lazy object retrieval.

- [ ] **Step 4: Run the new tests and confirm the expected red state.**

  From `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/git/git.test.ts
  ```

  Expected: compilation or assertions fail because `resolveCommit`, `changedFiles`, and `patchBetween` do not exist.

- [ ] **Step 5: Add the minimal Git operations.**

  In `src/git/index.ts`, add a reused read-only environment and a concise command failure conversion:

  ```ts
  const READ_ONLY_ENV = { GIT_NO_LAZY_FETCH: "1" }

  const commandError = (operation: string, result: Result) =>
    new Error(result.stderr.toString("utf8").trim() || `Git ${operation} failed with exit code ${result.exitCode}`)
  ```

  Implement `resolveCommit` with exactly this Git argument shape and `READ_ONLY_ENV`:

  ```ts
  ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]
  ```

  Return the trimmed full ID only for exit code zero and non-empty output; return `undefined` otherwise.

  Implement `changedFiles` by running both commands below from the supplied repository root:

  ```ts
  [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-status",
    "-z",
    base,
    target,
    "--",
  ]

  [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--numstat",
    "-z",
    base,
    target,
    "--",
  ]
  ```

  Check each exit code before parsing. Fail with `commandError` instead of turning command failure into an empty comparison. Reuse the existing NUL parsing and status conversion, merge statistics by exact filename, default absent or binary counts to zero, and sort with:

  ```ts
  files.toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  ```

  Implement `patchBetween` with the global literal-pathspec option before `diff`:

  ```ts
  [
    "--literal-pathspecs",
    "diff",
    "--patch",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    base,
    target,
    "--",
    file,
  ]
  ```

  Use `READ_ONLY_ENV`, check the exit code, and return raw stdout. Do not add a Git-level output cap; the common tool wrapper owns visible-output truncation.

- [ ] **Step 6: Export the operations from `Service.of` and run verification.**

  Add all three methods to the object returned at `src/git/index.ts:326`. From `packages/opencode` run:

  ```powershell
  bun test --timeout 30000 test/git/git.test.ts
  bun typecheck
  ```

  Expected: all Git tests pass and typecheck exits zero.

- [ ] **Step 7: Commit the Git boundary.**

  ```powershell
  git add src/git/index.ts test/git/git.test.ts
  git commit -m "feat(opencode): add read-only commit diff primitives"
  ```

---

## Task 2: Add the `git_diff` built-in tool

**Files:**

- Create: `packages/opencode/src/tool/git-diff.ts`
- Create: `packages/opencode/src/tool/git-diff.txt`
- Modify: `packages/opencode/src/tool/registry.ts:1-55, 112-130, 227-267, 450-475`
- Create: `packages/opencode/test/tool/git-diff.test.ts`
- Modify: `packages/opencode/test/tool/parameters.test.ts:1-70`
- Modify: `packages/opencode/test/tool/__snapshots__/parameters.test.ts.snap`
- Modify: `packages/opencode/test/tool/registry.test.ts:164-178`

**Tool contract:**

```ts
export const Parameters = Schema.Struct({
  base: Schema.NonEmptyString.annotate({ description: "The older Git commit revision" }),
  target: Schema.NonEmptyString.annotate({ description: "The newer Git commit revision" }),
  path: Schema.optional(Schema.NonEmptyString).annotate({
    description: "One exact repository-relative file path returned by the summary",
  }),
})

type Metadata = {
  base: string
  target: string
  path?: string
  files?: number
  truncated?: boolean
  outputPath?: string
}
```

- [ ] **Step 1: Write standalone tool tests.**

  In `test/tool/git-diff.test.ts`, use `TestInstance`, real commits, `Git.node`, `Truncate.node`, and `Agent.node`. Add these cases:

  - `returns a sorted summary and resolved commit metadata without patches`;
  - `returns only the requested exact file patch`;
  - `returns stable no-change output for identical commits and unchanged paths`;
  - `rejects a non-Git worktree`;
  - `rejects absolute and escaping paths before Git execution`;
  - `reports invalid base and target separately`;
  - `uses common truncation for an oversized patch`;
  - `does not request permission`.

  Make `ctx.ask` fail the test if invoked. For the summary, assert the output is a JSON array of `ChangedFile` records and contains no `diff --git`. For follow-up calls, pass the full IDs from summary metadata, not the original branch or tag names. For a path call, first assert the requested normalized path exactly matches an entry from `changedFiles`; a directory or unmatched path must produce the no-change response rather than a multi-file patch.

- [ ] **Step 2: Add the parameter-schema test first and confirm red tests.**

  Import `Parameters as GitDiff` in `test/tool/parameters.test.ts`. Add the `git_diff` wire-schema case, asserting non-empty `base` and `target`, optional non-empty `path`, and no field for options or commands.

  From `packages/opencode` run:

  ```powershell
  bun test --timeout 30000 test/tool/git-diff.test.ts test/tool/parameters.test.ts
  ```

  Expected: tests fail because the tool and schema do not exist.

- [ ] **Step 3: Implement the tool without a permission boundary.**

  Define `GitDiffTool` with `Tool.define<typeof Parameters, Metadata, Git.Service>("git_diff", ...)`. Its execute path must:

  1. read `InstanceState.context` and fail clearly when `instance.project.vcs !== "git"`;
  2. validate and normalize `path`, when present, before invoking any Git command;
  3. resolve `base` and then `target`, with distinct `Invalid base revision: ...` and `Invalid target revision: ...` failures;
  4. when `path` is absent, return title `${base.slice(0, 12)}..${target.slice(0, 12)}`, `JSON.stringify(files, null, 2)`, and `{ base, target, files: files.length }`;
  5. use the normalized forward-slash path, require an exact entry in `changedFiles`, and return `No changes for <path>.` when it is not present;
  6. when it is present, return title `path`, the raw one-file patch, and `{ base, target, path }`.

  Use this validation shape without checking current filesystem existence, so deleted historical files remain valid:

  ```ts
  if (path.isAbsolute(params.path)) throw new Error("Path must be repository-relative")
  const absolute = path.resolve(instance.worktree, params.path)
  if (!FSUtil.contains(instance.worktree, absolute)) throw new Error("Path must stay within the worktree")
  const relative = path.relative(instance.worktree, absolute).replaceAll("\\", "/")
  if (!relative) throw new Error("Path must identify one file from the summary")
  ```

  Do not call `ctx.ask`. End the execute effect with `Effect.orDie` as required by the tool interface, and let `Tool.define` append `truncated` and `outputPath` metadata.

- [ ] **Step 4: Write the model-facing description.**

  `src/tool/git-diff.txt` must state all of the following explicitly:

  - the tool compares committed snapshots only;
  - call it first with `base` and `target` and no `path`;
  - the first call returns a changed-file summary, not patches;
  - select one path from that summary for each follow-up call;
  - reuse the resolved base and target IDs from metadata for follow-ups;
  - use `read`, `glob`, and `grep` for current worktree content;
  - the tool cannot mutate Git state or run arbitrary commands.

- [ ] **Step 5: Register the built-in for normal tool resolution.**

  In `src/tool/registry.ts`, import `GitDiffTool` and `Git`, initialize the tool beside the other built-ins, include it in the normal built-in list, and add `Git.node` to the registry dependency group. Do not alter `PLAN_TOOLS` in this task; Task 3 changes the Plan boundary atomically. Add a registry test asserting Build receives both `bash` and `git_diff` and `plan_exit` remains excluded from Build.

- [ ] **Step 6: Update and inspect the schema snapshot.**

  From `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/tool/parameters.test.ts -u
  git diff -- test/tool/__snapshots__/parameters.test.ts.snap
  bun test --timeout 30000 test/tool/parameters.test.ts
  ```

  Confirm the snapshot contains only `base`, `target`, and optional `path` for `git_diff`.

- [ ] **Step 7: Run focused tests and typecheck.**

  ```powershell
  bun test --timeout 30000 test/tool/git-diff.test.ts test/tool/parameters.test.ts test/tool/registry.test.ts
  bun typecheck
  ```

  Expected: tests pass, oversized output uses common truncation metadata, and typecheck exits zero.

- [ ] **Step 8: Commit the tool.**

  ```powershell
  git add src/tool/git-diff.ts src/tool/git-diff.txt src/tool/registry.ts test/tool/git-diff.test.ts test/tool/parameters.test.ts test/tool/__snapshots__/parameters.test.ts.snap test/tool/registry.test.ts
  git commit -m "feat(opencode): add read-only git diff tool"
  ```

---

## Task 3: Replace Plan Bash with `git_diff`

**Files:**

- Modify: `packages/opencode/src/tool/registry.ts:58-71, 309-327`
- Modify: `packages/opencode/src/session/tools.ts:33-46, 417-429, 524-529`
- Modify: `packages/opencode/src/session/prompt/plan-mode.txt:1-5`
- Modify: `packages/opencode/src/tool/shell.ts:625-627`
- Modify: `packages/opencode/test/tool/registry.test.ts:109-162`
- Modify: `packages/opencode/test/session/tools.test.ts:21-148, 196-297`
- Modify: `packages/opencode/test/session/instruction.test.ts:364-380`
- Modify: `packages/opencode/test/tool/shell.test.ts:1206-1286`
- Modify: `packages/opencode/test/agent/agent.test.ts:72-123`

**Invariant:** `Permission.evaluate("bash", ..., plan.permission)` may still return `allow` after enterprise configuration, but neither registry output nor final `SessionTools` output may contain `bash` for `agentID === "plan"`.

- [ ] **Step 1: Change the Plan boundary tests first.**

  In `test/tool/registry.test.ts`, rename the existing desktop Plan test to `Plan exposes only structurally authorized read and planning tools`. Keep its wildcard permission input and change assertions so:

  - the exact registry-level Plan list contains `git_diff`, `glob`, `grep`, `plan_exit`, `question`, `read`, `todowrite`, `webfetch`, and `websearch`; the resource tools are added and checked later by `SessionTools`;
  - `bash` is absent;
  - Build contains both `bash` and `git_diff`;
  - a custom `git_diff.ts` cannot replace the canonical built-in;
  - existing malicious custom `read` and `todowrite` checks remain.

  In `test/session/tools.test.ts`, replace `bash` with `git_diff` in `keeps exactly the Plan-authorized tools`, strengthen the Build identity test with both tool IDs, and replace the tests that execute Plan Bash through a reusable permission with one structural regression: supply canonical `bash` and `git_diff` tools plus an enterprise-like `bash: { "*": "allow" }` ruleset, then assert final Plan resolution omits Bash and retains `git_diff` without entering Bash permission execution. Extend the MCP collision test with an MCP `git_diff` and assert Plan keeps the canonical built-in.

- [ ] **Step 2: Change prompt and obsolete Plan-Shell tests first.**

  In `test/session/instruction.test.ts`, replace the shell/permission assertions with positive assertions for `git_diff`, `read`, `glob`, and `grep`, and negative assertions for instructions to request shell commands or permissions. Preserve Plan workflow, read-only, and Build-switch assertions.

  In `test/tool/shell.test.ts`, retain the environment-snapshot test as a generic Shell permission test, but remove the two tests whose only behavior is the native Plan fallback for empty or malformed shell parsing. In `test/agent/agent.test.ts`, keep direct-edit and subagent denial coverage but remove Plan Bash allow/deny assertions that no longer represent tool authorization. Do not change `src/agent/agent.ts`; its permission merge semantics are outside the structural boundary.

- [ ] **Step 3: Run the changed tests and confirm the expected red state.**

  From `packages/opencode`:

  ```powershell
  bun test test/tool/registry.test.ts test/session/tools.test.ts test/session/instruction.test.ts test/tool/shell.test.ts test/agent/agent.test.ts
  ```

  Expected: Plan list and prompt assertions fail until production allowlists and prompt text change.

- [ ] **Step 4: Replace Bash in both structural allowlists.**

  In both `src/tool/registry.ts` and `src/session/tools.ts`, replace only the `"bash"` entry in `PLAN_TOOLS` with `"git_diff"`. Keep the two filters in place:

  - registry filtering ensures custom tools and enterprise permission rules cannot introduce Bash;
  - final `SessionTools` filtering covers MCP collisions and every tool assembly path.

  Do not add a Bash deny rule. Build continues through the unfiltered path.

- [ ] **Step 5: Remove the now-unreachable Plan-specific Shell fallback.**

  In `src/tool/shell.ts`, remove only this branch:

  ```ts
  if ((tree.rootNode.hasError || scan.patterns.size === 0) && ctx.extra?.agentID === "plan") {
    scan.patterns.add(params.command)
  }
  ```

  Keep all generic shell parsing, permission, environment snapshot, and Build behavior unchanged.

- [ ] **Step 6: Rewrite the Plan reminder's first paragraph.**

  Replace the current shell-command and permission-boundary wording in `plan-mode.txt` with:

  ```text
  Inspect project files with `read`, `glob`, and `grep`, and compare committed repository snapshots with `git_diff`. No shell or generic process execution is available in Plan. Do not edit files, install dependencies, deploy, or change Git state.
  ```

  Preserve the remaining planning workflow, clarification, final-plan, and `plan_exit` instructions.

- [ ] **Step 7: Run focused and full package verification.**

  ```powershell
  bun test test/tool/registry.test.ts test/session/tools.test.ts test/session/instruction.test.ts test/tool/shell.test.ts test/agent/agent.test.ts
  bun typecheck
  ```

  Expected: Plan exposes `git_diff`, not Bash, even with wildcard Bash permission; Build still exposes Bash; reminder text contains no Shell request path.

- [ ] **Step 8: Commit the structural boundary.**

  ```powershell
  git add src/tool/registry.ts src/session/tools.ts src/session/prompt/plan-mode.txt src/tool/shell.ts test/tool/registry.test.ts test/session/tools.test.ts test/session/instruction.test.ts test/tool/shell.test.ts test/agent/agent.test.ts
  git commit -m "fix(opencode): remove shell from plan tools"
  ```

---

## Task 4: Reject direct Plan shell requests in the backend

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts:102-107, 1379-1384, 1569-1576`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session-errors.ts:10-20`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:341-347`
- Modify: `packages/opencode/test/session/prompt.test.ts:1647-1817`
- Modify: `packages/opencode/test/server/httpapi-exercise/index.ts:1528-1548`

**Internal error contract:**

```ts
export class PlanShellUnavailableError extends Schema.TaggedErrorClass<PlanShellUnavailableError>()(
  "PlanShellUnavailableError",
  { sessionID: SessionID },
) {}

// Interface.shell and the concrete shell function expose this union.
Effect.Effect<SessionV1.WithParts, Session.BusyError | PlanShellUnavailableError>
```

- [ ] **Step 1: Write a side-effect-free rejection test.**

  Add `shell rejects Plan before runner or process startup` beside the existing Shell semantics tests. Create an empty session and a marker path inside `TestInstance.directory`. Build a cross-platform command that would write the marker if any shell process starts:

  ```ts
  const script = `await Bun.write(${JSON.stringify(marker)}, "ran")`
  const command = `bun -e ${JSON.stringify(script)}`
  ```

  Call `prompt.shell({ agent: "plan", command })` through `Effect.exit`, then assert:

  - the failure is `PlanShellUnavailableError` with the session ID;
  - session messages remain empty;
  - `Bun.file(marker).exists()` is false;
  - `SessionRunState.assertNotBusy(sessionID)` succeeds after rejection.

  Keep all existing Build shell tests unchanged.

- [ ] **Step 2: Add the HTTP 400 exercise before changing the handler.**

  In `test/server/httpapi-exercise/index.ts`, add a second `POST /session/{sessionID}/shell` case named `"session.shell.plan"` using `agent: "plan"` and finish it with `.json(400, object, "status")`. Keep the existing Build case expecting 200 and `shell-ok` output.

- [ ] **Step 3: Run the focused tests and confirm red state.**

  From `packages/opencode`:

  ```powershell
  bun test test/session/prompt.test.ts -t "shell rejects Plan"
  bun run script/httpapi-exercise.ts --mode effect
  ```

  Expected: the current public shell path enters `SessionRunState`, creates messages, and runs the marker command, so the new assertions fail.

- [ ] **Step 4: Define the typed internal error and guard the public shell function.**

  Add `PlanShellUnavailableError` next to `ShellInput`, and add it to `Interface.shell` and the concrete `shell` function's error channel.

  Reject the canonical Plan ID before creating the readiness latch or entering `SessionRunState`:

  ```ts
  const shell: (
    input: ShellInput,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError | PlanShellUnavailableError> = Effect.fn(
    "SessionPrompt.shell",
  )(function* (input: ShellInput) {
    if (input.agent === "plan") {
      return yield* new PlanShellUnavailableError({ sessionID: input.sessionID })
    }
    const ready = yield* Latch.make()
    return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
  })
  ```

  Do not add an error to `shellImpl`: `SessionRunState.startShell` intentionally accepts work with a `never` error channel. The public guard is earlier than instance lookup, revert cleanup, agent/model lookup, message insertion, plugin environment hooks, process spawn, and runner busy-state mutation.

- [ ] **Step 5: Map the typed error to the endpoint's existing 400.**

  Generalize `SessionError.mapBusy` to preserve unrelated error types:

  ```ts
  export function mapBusy<A, E, R>(self: Effect.Effect<A, Session.BusyError | E, R>) {
    return self.pipe(
      Effect.catchTag("SessionBusyError", (error) =>
        Effect.fail(new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        })),
      ),
    )
  }
  ```

  In the shell handler only, follow `mapBusy` with:

  ```ts
  Effect.catchTag("PlanShellUnavailableError", () => Effect.fail(new HttpApiError.BadRequest({})))
  ```

  Do not add a new public HTTP error schema or response type.

- [ ] **Step 6: Run backend verification.**

  ```powershell
  bun test test/session/prompt.test.ts -t "shell rejects Plan"
  bun test test/session/prompt.test.ts
  bun run script/httpapi-exercise.ts --mode effect
  bun typecheck
  ```

  Expected: Plan fails before runner, message, and process side effects with HTTP 400; Build shell behavior and BusyError mapping remain unchanged.

- [ ] **Step 7: Commit the backend guard.**

  ```powershell
  git add src/session/prompt.ts src/server/routes/instance/httpapi/handlers/session-errors.ts src/server/routes/instance/httpapi/handlers/session.ts test/session/prompt.test.ts test/server/httpapi-exercise/index.ts
  git commit -m "fix(opencode): reject plan shell sessions"
  ```

---

## Task 5: Make V2 Shell availability explicit in Session UI

**Files:**

- Modify: `packages/session-ui/src/v2/components/prompt-input/machine.ts:17-95`
- Modify: `packages/session-ui/src/v2/components/prompt-input/interaction.ts:29-50, 162-186, 341-358`
- Modify: `packages/session-ui/src/v2/components/prompt-input/index.tsx:205-218, 470-520`
- Modify: `packages/session-ui/src/v2/components/prompt-input/machine.test.ts:56-89`

**Interface additions:**

```ts
export type PromptInputV2Capabilities = {
  shell: boolean
}

export type PromptInputV2ViewConfig = {
  // Existing fields remain unchanged.
  shell?: {
    enabled?: Accessor<boolean>
    onOpen?: () => void
    onClose?: () => void
  }
}
```

- [ ] **Step 1: Write machine tests for disabled Shell behavior.**

  Add tests proving that, with `{ shell: false }` passed to `transitionPromptInputV2`:

  - a `mode.shell` event leaves mode `normal`;
  - initial input `!` remains normal prompt text and is not replaced with an empty draft;
  - default/omitted capabilities preserve current Shell behavior.

- [ ] **Step 2: Run the machine tests and confirm red state.**

  From `packages/session-ui`:

  ```powershell
  bun test src/v2/components/prompt-input/machine.test.ts
  ```

  Expected: the capability does not exist, so disabled Shell events still enter Shell mode.

- [ ] **Step 3: Thread the capability through the state machine.**

  Add an optional fourth argument to `transitionPromptInputV2`:

  ```ts
  capabilities: PromptInputV2Capabilities = { shell: true }
  ```

  Gate both `mode.shell` and initial-`!` conversion on `capabilities.shell`. When disabled, `input.changed` must use the ordinary draft persistence path, preserving `!` as text.

- [ ] **Step 4: Centralize view-level enforcement.**

  In `interaction.ts`:

  - pass `{ shell: input.view.shell?.enabled?.() ?? true }` to every transition;
  - keep `openShell()` as a normal guarded dispatch;
  - add a `createEffect` that dispatches `mode.normal` when the accessor becomes false while mode is Shell;
  - make `onOpen` and `onClose` optional.

  In `index.tsx`, pass the current availability into `PromptInputV2AddMenu`, add an optional boolean prop, and wrap only the Shell menu item in `Show`. Attachments, commands, and context entries remain visible. Task 6's browser E2E test covers the reactive Build-Shell-to-Plan transition without adding a second Solid test harness here.

- [ ] **Step 5: Run Session UI verification.**

  ```powershell
  bun test src/v2/components/prompt-input/machine.test.ts
  bun typecheck
  ```

  Expected: disabled Shell events and initial `!` stay in normal mode, default behavior is unchanged, and the controller/UI capability typechecks.

- [ ] **Step 6: Commit the reusable capability.**

  ```powershell
  git add src/v2/components/prompt-input/machine.ts src/v2/components/prompt-input/interaction.ts src/v2/components/prompt-input/index.tsx src/v2/components/prompt-input/machine.test.ts
  git commit -m "feat(session-ui): support disabling shell mode"
  ```

---

## Task 6: Disable every App Shell entry point for Plan

**Files:**

- Modify: `packages/app/src/components/prompt-input.tsx:301-319, 483-517, 1305-1313`
- Modify: `packages/app/src/components/prompt-input-v2.tsx:108-110, 335-451`
- Modify: `packages/app/src/components/prompt-input/submit.ts:329-365`
- Modify: `packages/app/src/components/prompt-input/submit.test.ts`
- Modify: `packages/app/e2e/regression/session-request-docks.spec.ts:358-470`
- Modify: `packages/app/e2e/regression/legacy-new-session.spec.ts`

**App invariant:** `props.controls.agents.current === "plan"` is the canonical selected agent ID for both composers. Shell remains available for Build.

- [ ] **Step 1: Write the shared submission regression first.**

  Make the mocked current-agent name mutable in `submit.test.ts` and reset it after each test. Add `does not submit or create a session for Plan Shell mode` with a non-empty draft. Assert:

  - no session is created;
  - `session.shell` is not called;
  - history, queue, and `onSubmit` callbacks are not called;
  - the draft and context remain intact;
  - the composer is returned to normal mode.

  Keep the existing Build Shell success/failure tests unchanged.

- [ ] **Step 2: Write App E2E coverage for both composers.**

  In `session-request-docks.spec.ts`, reuse the existing Build/Plan agent mock and Plan selection flow for V2. Assert:

  - Build shows and can enter `Shell command`;
  - Plan omits the Add-menu Shell item and disables the Shell command/keybind;
  - typing an initial `!` in Plan leaves `!` in the normal draft;
  - switching Build Shell to Plan returns to normal mode without clearing the draft.

  In `legacy-new-session.spec.ts`, configure `mockOpenCodeServer` with `protocol: "v2"` and explicit Build/Plan agents while retaining `newLayoutDesigns: false`, then add the equivalent command/keybind and initial-`!` assertions. Do not change `e2e/utils/mock-server.ts`.

- [ ] **Step 3: Run focused tests and confirm red state.**

  From `packages/app`:

  ```powershell
  bun test --conditions=solid --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts
  bun run test:e2e -- e2e/regression/session-request-docks.spec.ts e2e/regression/legacy-new-session.spec.ts --workers=1
  ```

  Expected: current Plan composers still expose or submit Shell.

- [ ] **Step 4: Add the shared last-line submission guard.**

  In `submit.ts`, after blank-input handling and successful model/agent resolution but before `clearInput`, history mutation, session creation, or API calls, add:

  ```ts
  if (mode === "shell" && currentAgent.name === "plan") {
    input.setMode("normal")
    return
  }
  ```

  Keep blank-input stop behavior before this guard so stopping a running session is unchanged. Do not clear or restore the draft in this branch.

- [ ] **Step 5: Disable Shell in the legacy composer.**

  In `prompt-input.tsx`, derive:

  ```ts
  const shellEnabled = () => props.controls.agents.current !== "plan"
  ```

  Then:

  - make `setMode("shell")` return immediately when disabled;
  - mark `prompt.mode.shell` disabled when `!shellEnabled()`;
  - route its `onSelect` through guarded `setMode`;
  - gate the initial-`!` key handler on `shellEnabled()` so the browser inserts ordinary text in Plan;
  - add a reactive effect that calls `setMode("normal")` if Plan is selected while Shell is open.

  Do not clear the prompt, context, or history when the effect closes Shell.

- [ ] **Step 6: Disable Shell in the V2 composer.**

  In `prompt-input-v2.tsx`, derive the same `shellEnabled` accessor, pass it as `view.shell.enabled`, and add `!shellEnabled()` to the `prompt.mode.shell` command's disabled condition. The Session UI capability from Task 5 then covers Add-menu visibility, controller calls, initial `!`, and an already-open Shell composer.

- [ ] **Step 7: Run App verification.**

  ```powershell
  bun test --conditions=solid --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts
  bun run test:e2e -- e2e/regression/session-request-docks.spec.ts e2e/regression/legacy-new-session.spec.ts --workers=1
  bun run typecheck:e2e
  bun typecheck
  ```

  Expected: Plan cannot enter or submit Shell in either composer; leading `!` is preserved; switching from Build Shell to Plan keeps the draft; Build remains unchanged.

- [ ] **Step 8: Commit the App behavior.**

  ```powershell
  git add src/components/prompt-input.tsx src/components/prompt-input-v2.tsx src/components/prompt-input/submit.ts src/components/prompt-input/submit.test.ts e2e/regression/session-request-docks.spec.ts e2e/regression/legacy-new-session.spec.ts
  git commit -m "fix(app): disable shell in plan"
  ```

---

## Task 7: Run integrated regression verification

**Files:** No planned source changes. If verification finds a defect, fix it in the task that owns the affected behavior and amend that task's commit only after rerunning its focused tests.

- [ ] **Step 1: Verify OpenCode from its package directory.**

  From `packages/opencode`:

  ```powershell
  bun test --timeout 30000 test/git/git.test.ts
  bun test --timeout 30000 test/tool/git-diff.test.ts test/tool/parameters.test.ts test/tool/registry.test.ts
  bun test test/session/tools.test.ts test/session/instruction.test.ts test/tool/shell.test.ts test/agent/agent.test.ts
  bun test test/session/prompt.test.ts
  bun run test:httpapi
  bun typecheck
  ```

- [ ] **Step 2: Verify Session UI from its package directory.**

  From `packages/session-ui`:

  ```powershell
  bun test src/v2/components/prompt-input/machine.test.ts
  bun typecheck
  ```

- [ ] **Step 3: Verify the App from its package directory.**

  From `packages/app`:

  ```powershell
  bun test --conditions=solid --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts
  bun run test:e2e -- e2e/regression/session-request-docks.spec.ts e2e/regression/legacy-new-session.spec.ts --workers=1
  bun run typecheck:e2e
  bun typecheck
  ```

- [ ] **Step 4: Inspect the final repository diff.**

  From the repository root, run read-only checks:

  ```powershell
  git diff --check dev...HEAD
  git diff --stat dev...HEAD
  git status --short
  ```

  Confirm:

  - no generated client or SDK files changed;
  - no dependency or lockfile changed;
  - Plan contains `git_diff` and no Bash tool at both filters;
  - Build contains both tools;
  - all commit diff invocations use resolved IDs, fixed options, `--`, no lazy fetch, and literal path handling;
  - direct Plan Shell fails before message/process side effects;
  - both App composers remove Shell in Plan while preserving drafts;
  - the working tree is clean after the intended commits.

  Do not create an empty verification commit.
