# Initial Prompt Single-Submit Design

## Problem

When a user submits the first prompt for a project, the app waits for worktree and session creation before clearing the composer. During that wait the original text remains visible, so separate Enter presses each start another submission. The existing `KeyboardEvent.repeat` guard only covers operating-system key repeat while a key is held; it does not cover multiple discrete Enter presses.

The result can be multiple sessions, tabs, and copies of the same request from one intended first prompt.

## Desired behavior

- Clear the composer immediately after the first prompt passes validation and is admitted for submission.
- Ignore every additional submit attempt while that admission is still in progress.
- Create and promote exactly one session and send the captured prompt exactly once.
- Release the submission guard after success or failure so a later intentional submission can proceed.
- If worktree or session creation fails, restore the captured prompt and context when the cleared composer has not been edited in the meantime.
- Never overwrite text the user entered after the optimistic clear.

## Design

Keep the guard local to the `createPromptSubmit` instance so unrelated composers and sessions remain independent. Wrap the existing submit operation with a synchronous in-flight check: the first invocation claims the guard before any asynchronous work, and a `finally` path releases it. Calls received while the guard is held return without creating a worktree, session, tab, optimistic message, or request.

After prompt, model, and agent validation succeeds, capture the prompt and context using the existing submission state and clear the active composer before awaiting worktree or session creation. Move the clear and restore operations early enough to cover creation failures as well as send failures.

Extend the submission-state transition so retargeting a submission that has already been cleared also leaves the destination session composer clear. Before a clear, retargeting continues to copy the captured context as it does today. Restoration remains conditional on the destination still matching the cleared state, which prevents a failed request from overwriting newer user input.

This is an app-only behavior change. It does not alter protocol, server, or generated client APIs.

## Failure handling

Worktree creation, session creation, shell execution, custom command execution, and normal prompt errors continue to use their existing toasts. Any failure after the optimistic clear attempts to restore the captured prompt and context. The guard is released regardless of which path exits.

If the user has entered a new draft before a failure is reported, restoration does not replace that draft. The captured failed prompt remains unrestored rather than destroying newer input.

## Testing

Add focused regression coverage under the existing prompt submission tests:

1. Hold session creation behind a promise, invoke submission three times, and verify the composer clears synchronously while only one session and one request are produced.
2. Reject or fail session creation after the optimistic clear and verify the original prompt can be restored and a later submission can retry.
3. Verify retargeting an already-cleared submission leaves the new session composer empty.
4. Run the prompt submission test file and the `packages/app` typecheck from the package directory.

## Out of scope

- Server-side idempotency keys or protocol changes.
- Disabling all composer editing while session creation is pending.
- Changes to queueing behavior for established sessions.
- Unrelated prompt input or tab lifecycle refactors.
