# Enterprise Credential Sidecar Restart Design

## Goal

Saving or clearing Company LLM credentials must refresh the Enterprise sidecar without closing the Desktop application. The change must preserve encrypted-at-rest credentials, keep secrets out of environment variables and renderer-visible responses, and recover the previous working state when a restart fails.

## Root Cause

The credential store currently returns `restartRequired: true` after every successful mutation. `DialogCompanyProvider` interprets this as a request to call `platform.restart()`, which invokes Electron `app.relaunch()` and then exits the process. This is especially broken under `electron-vite dev`: the Electron child exit also terminates the parent development server, so the relaunched process cannot keep a usable renderer session.

The renderer warnings reported before shutdown are unrelated. The final `sidecar exited { code: 0 }` entry is produced by the orderly shutdown inside the relaunch path, not by a provider or renderer crash.

## Alternatives

### 1. Restart only the Enterprise sidecar (selected)

Persist the credential mutation in Electron main, restart the sidecar on the existing port with the active Skill Pack paths, and return `restartRequired: false` to the renderer. This reuses the restart mechanism already exercised by Skill Pack toggles and keeps the Desktop window and development server alive.

### 2. Require a manual development restart

Avoid `app.relaunch()` only when `app.isPackaged` is false and ask developers to rerun the command. This prevents the abrupt close but leaves an unnecessary development-only workflow and does not improve packaged UX.

### 3. Hot-inject secrets into a running sidecar

Add a private credential-update channel to mutate the sidecar without a restart. This reduces interruption but creates a new secret-bearing transport and broadens the security surface beyond the current startup-message boundary.

## Architecture

Add a Desktop-main credential runtime controller around the existing credential handlers. The existing handlers remain responsible only for model validation and DPAPI-backed persistence. The controller serializes mutations across windows and coordinates sidecar lifecycle:

1. Read the normalized credential map into Electron main memory as the rollback snapshot.
2. Execute the requested model-specific save or clear operation.
3. Restart the Enterprise sidecar with the current enabled Skill Pack paths.
4. On success, return `{ restartRequired: false }`.
5. On restart failure, restore the previous credential snapshot and restart the sidecar once more with the restored credentials.
6. If recovery succeeds, reject the original mutation so the UI shows its existing safe request failure and the previous state remains authoritative.
7. If credential restoration or the recovery restart also fails, reject with a fixed safe error that directs the user to restart the Desktop app. No secret values may appear in the message or structured log metadata.

The controller uses a promise queue so two windows cannot take overlapping snapshots or roll back over a later successful write.

`spawnSidecar()` already reads `enterpriseCredentials.all()` immediately before constructing the startup command. Therefore both the first restart and a rollback restart receive the correct credential snapshot without adding environment variables, public APIs, or a new sidecar command.

## Components and Data Flow

- `enterprise-credentials.ts` keeps storage, validation, catalog, status, save, and clear behavior unchanged.
- A new Desktop-main controller composes the credential handlers with `enterpriseCredentials.all()`, `enterpriseCredentials.setAll()`, and `restartEnterpriseSidecar(enabledSkillPackPaths())`.
- `index.ts` exposes the controller’s save and clear methods through the existing IPC channels.
- Desktop IPC and preload result types change from the literal `restartRequired: true` to `restartRequired: boolean`.
- `DialogCompanyProvider` requires no production behavior change: its existing mutation helper already skips `platform.restart()` when `restartRequired` is false, clears local plaintext inputs, and refetches the catalog.
- Public Server `HttpApi`, Protocol, generated clients, sidecar environment, and credential file format remain unchanged.

## Error Handling

- Persistence failure: do not restart; preserve the current sidecar and local plaintext input.
- New-state restart failure with successful rollback: restore the prior credential file and prior sidecar, then report the original request failure.
- Restore or recovery restart failure: report a fixed safe recovery error and require a manual Desktop restart.
- Sidecar exit code `0` during an intentional restart remains informational lifecycle behavior; it must not trigger an app exit.

## Testing

- Controller unit tests use the real encrypted credential store with temporary files and deterministic encryption adapters.
- Verify a successful save and clear each restart the sidecar once and return `restartRequired: false`.
- Verify restart failure restores the exact previous model-scoped credential map and performs one recovery restart.
- Verify concurrent mutations are serialized and cannot overwrite a later state with an earlier rollback.
- Verify recovery failure emits only the fixed safe error.
- Keep existing App tests proving `restartRequired: false` does not call `platform.restart()` and `restartRequired: true` remains supported for other callers.
- Run focused Desktop and App tests plus `bun typecheck` from their package directories.
- In Enterprise development mode, save a credential and verify that the same Desktop process remains open, the sidecar becomes healthy again, and the catalog reports the credential as configured.

## Compatibility

Packaged and development Enterprise builds use the same sidecar-only path. Existing encrypted credential files remain valid. Ordinary OpenCode builds, Skill Pack behavior, project-defined skills, public provider authentication, and external server connections are unaffected.
