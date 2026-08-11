# Plan Read-Only Git Diff Design

## Context

Plan currently exposes the generic `bash` tool. Its native `bash: "ask"` permission is merged before global permissions, while the shipped enterprise defaults allow `bash` with a wildcard. That makes ordinary shell commands auto-allowed in Plan and permits workspace mutation without a Build transition.

Removing Bash closes that model-tool path, but Plan still needs to compare repository history while investigating a change. The required Git scope is deliberately narrow: compare any two commits, first as a changed-file summary and then as a patch for one selected file. Plan continues to read and search current files through `read`, `glob`, and `grep`.

This design supersedes only the prior decision that Plan Bash should use the shared permission flow in `2026-08-06-plan-permission-rollback-design.md`. The rest of that rollback remains unchanged.

## Decision

Remove `bash` from Plan's tool allowlist and add a built-in read-only `git_diff` tool. Build keeps Bash and also receives the new tool through the normal built-in registry.

Do not implement a Bash command allowlist. Command-pattern matching is not a reliable read/write boundary, global enterprise rules can override it, and Git options or configured helpers can introduce execution paths. Do not add a general-purpose Git tool; status, log, show, apply, checkout, and mutation operations are outside this request.

The backend must also reject direct `session.shell` execution when the selected agent is Plan. Hiding Shell mode only in the UI is insufficient because API callers could bypass the UI.

## Tool contract

`git_diff` accepts:

- `base`: required non-empty Git revision naming the older commit.
- `target`: required non-empty Git revision naming the newer commit.
- `path`: optional repository-relative file path.

Accepted revisions include full or abbreviated object IDs, branch names, tags, and revision expressions such as `HEAD~1`. Each input is resolved with `git rev-parse --verify --end-of-options <revision>^{commit}`. The tool uses only the resulting full commit IDs in later commands. An input that does not resolve to a commit fails before diff execution.

When `path` is absent, the tool returns a deterministic list sorted by file path containing:

- file path;
- status (`added`, `deleted`, or `modified`);
- added line count;
- deleted line count.

It does not return patches in this summary call.

When `path` is present, the tool returns only that file's patch between the same resolved commits. The path must be relative to the current worktree and remain within it. A path not changed between the commits returns an explicit no-change result.

Tool metadata includes the resolved base and target commit IDs, the optional path, and the common tool truncation metadata. The model must use those returned commit IDs, rather than movable branch or tag names, for follow-up file calls so the summary and patches describe the same snapshot even if a ref moves concurrently.

## Git execution

Reuse the existing `Git.Service` process boundary and argument-array execution. Add the smallest internal operations needed to:

1. resolve a revision to a commit ID;
2. collect name/status and numeric statistics for two resolved commits;
3. produce a patch for one exact path between those commits.

Diff invocations use fixed options and a `--` separator. At minimum they include:

- `--no-ext-diff`, preventing configured external diff drivers;
- `--no-textconv`, preventing configured text-conversion commands, which `git diff` otherwise enables by default;
- `--no-renames`, preserving the repository's existing VCS diff behavior;
- explicit resolved commit IDs instead of caller-provided Git arguments.

The existing Git process boundary already applies `--no-optional-locks`. The new read-only operations also set `GIT_NO_LAZY_FETCH=1` so a partial clone cannot fetch missing objects on demand, and treat the optional file path as a literal pathspec. Missing local objects therefore fail the call instead of accessing the network or populating the object database. Git documents both textconv's default behavior and these read-only controls in the official [`git diff`](https://git-scm.com/docs/git-diff.html) and [`git`](https://git-scm.com/docs/git.html) references.

The tool never invokes a command shell and never accepts free-form Git options. It does not call `git apply`, update refs or the index, access the network, or include uncommitted and untracked files in a two-commit comparison.

The common tool wrapper retains its existing 2,000-line/50 KiB visible-output limit and truncation behavior. Summary-first usage keeps normal calls compact; the model requests patches only for files relevant to its analysis.

## Runtime flow

1. The Plan model calls `git_diff` with `base` and `target`.
2. The tool resolves both inputs to commit IDs.
3. The tool returns the changed-file summary without patch bodies.
4. The model chooses a relevant file and calls `git_diff` again with the resolved commit IDs from the summary metadata and `path`.
5. The tool validates the path and returns that file's patch.
6. The model uses `read`, `grep`, or another `git_diff` call for additional analysis.

No permission request is needed because every reachable operation is constrained to repository reads. Enterprise Bash permissions cannot affect this path because Bash is absent from the Plan tool set.

## Error handling

- Non-Git worktree: fail with a clear repository error.
- Missing or non-commit revision: identify whether `base` or `target` is invalid without attempting a diff.
- Missing partial-clone object: fail without fetching it.
- Absolute or escaping path: reject it before invoking Git.
- Unchanged path: return a successful no-change response.
- Git execution failure: surface a concise failure without falling back to Bash.
- Oversized patch: use the existing tool-output truncation mechanism and metadata.

## Integration

- Register `git_diff` as a normal built-in tool.
- Replace `bash` with `git_diff` in `PLAN_TOOLS`.
- Add the Git service dependency required by the registry/tool layer.
- Keep `read`, `glob`, `grep`, Plan exit, question, todo, web, and read-only MCP resource tools unchanged.
- Keep Build's tool set and Bash permissions unchanged.
- Reject Plan direct-shell requests in `SessionPrompt.shellImpl` before creating messages or spawning a process.
- Disable or hide the App Shell-mode entry while Plan is selected, while retaining the backend check as the authority.
- Update `plan-mode.txt` to remove shell and permission-boundary instructions and direct Plan to `git_diff`, `read`, `glob`, and `grep` for repository inspection.

No public Protocol or Server `HttpApi` changes are required, so client and SDK regeneration is not part of this work.

## Verification

Use real temporary Git repositories rather than mocks. Tests must prove:

- Plan exposes `git_diff` and does not expose `bash`, even with enterprise `bash: { "*": "allow" }` defaults.
- Build still exposes Bash.
- Two arbitrary commits produce the correct sorted summary and line statistics.
- Full IDs, abbreviated IDs, branches, tags, and `HEAD~N` expressions resolve correctly.
- A path-specific call returns only that file's patch.
- Invalid revisions, option-shaped revisions, absolute paths, and paths escaping the worktree are rejected.
- Identical commits and unchanged paths return stable empty/no-change results.
- Configured external diff and textconv helpers are not executed.
- A partial clone cannot lazily fetch missing objects during either revision resolution or diff generation.
- A Plan `session.shell` request is rejected before message creation and process spawn; a Build request remains unchanged.
- Existing Plan `read`, `glob`, and `grep` access still works.
- The Plan prompt no longer instructs the model to request shell commands.

Run targeted tests and `bun typecheck` from `packages/opencode`. Run the focused App tests and App typecheck from `packages/app` if the Shell-mode UI is changed. Never run tests from the repository root.

## Acceptance criteria

- A normal Plan turn has no generic shell or arbitrary process-execution tool.
- Plan can compare any two revisions that resolve to commits.
- The first comparison returns only a compact file summary; a second call returns one selected file's patch.
- Commit and path inputs cannot be interpreted as Git options or escape the worktree.
- Git-configured external diff and textconv commands cannot run through the tool.
- Missing partial-clone objects cannot trigger network access or repository writes.
- Enterprise Bash wildcard permissions cannot restore Bash to Plan.
- Direct Plan Shell mode is rejected by the backend.
- Build Bash behavior and all unrelated Plan tools remain unchanged.
