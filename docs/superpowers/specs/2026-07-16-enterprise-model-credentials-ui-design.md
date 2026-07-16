# Enterprise Model Credentials UI Design

## Goal

Provide a production-quality Enterprise settings experience where every configured model is visible with its URL, default-model marker, and credential state, while API keys and secret headers remain model-scoped and stored only through Electron secure storage.

## Context and Root Cause

The renderer currently derives its model list from the sidecar public config, while Electron main validates credential mutations against the model catalog captured when the main process started. During development, renderer/sidecar reload can expose a newly added `.env` model before Electron main restarts. The model appears selectable, but `setCredentials()` fails with `Enterprise credential model is not configured`.

The settings resource also previously invoked `credentialStatus("")` before the public config loaded. That immediate regression is fixed by suppressing status requests until a valid model ID exists, but a complete solution requires Electron main to expose its authoritative catalog and the UI to represent catalog mismatch explicitly.

## Architecture

Electron main exposes one read-only `credentialCatalog()` API. It returns the current main-process Enterprise models, the default model ID, and model-specific credential status without returning any secret. The renderer merges this authoritative catalog with the sidecar public model catalog for presentation:

- Models present in both catalogs are configurable.
- Models present in only one catalog are visible with `Restart required` and cannot be saved, cleared, or diagnosed.
- Model ID, name, and normalized URL remain public metadata.
- API keys and secret header values never enter config, logs, manifests, release metadata, or catalog responses.

Electron main remains the security boundary. Existing model-specific `credentialStatus`, `setCredentials`, and `clearCredentials` calls continue to validate the model ID even when the renderer has already checked eligibility.

## UI

The Company LLM dialog uses a two-part layout:

1. A model list shows every merged model with name, ID, URL, default marker, and one of these statuses:
   - `Credentials configured`
   - `Credentials not configured`
   - `Credentials must be re-entered`
   - `Restart required`
2. The selected-model editor shows its URL, API key field, secret-header rows, Save, Clear, and Test connection actions.

The default model is selected initially. Selecting another model clears all plaintext inputs, diagnostic output, readiness output, and local errors. Only the selected model can be mutated. The model selector is disabled during save, clear, and diagnostic operations.

When catalogs differ, the dialog displays a restart banner explaining that `.env` model changes require a full desktop restart. Actions for mismatched models are disabled. Synchronized models remain configurable.

The provider settings summary displays the default model and its current credential state. It opens the same detailed dialog for all model-specific management.

## Data Flow

1. Electron main builds the authoritative model catalog from `ENTERPRISE_PROFILE`.
2. `credentialCatalog()` reads the encrypted credential map once and projects non-secret status for every authoritative model.
3. The preload forwards the catalog through a dedicated IPC channel.
4. The App loads both main catalog and sidecar public config.
5. A pure merge function produces ordered model rows and synchronization state.
6. Save/Clear refresh the catalog and update only the selected row.
7. Diagnostic calls use the selected synchronized model ID.

## Error Handling

- Catalog loading failures show a fixed safe error and disable credential mutations.
- Unknown model IDs remain rejected at the IPC/main boundary.
- A catalog mismatch never attempts a credential mutation; it presents `Restart required` instead.
- DPAPI unavailable/corrupt states are shown per model without exposing underlying secret data or filesystem paths.
- Successful mutation still requests a desktop restart according to the existing contract.

## Solid Cleanup Warning

The `cleanups created outside a createRoot or render` warning is caused by converting a toast icon name into JSX before `toaster.show()` establishes its Solid owner. The toast adapter will pass a lazy icon factory and resolve it inside the toaster callback, preserving the existing toast API while ensuring cleanup ownership.

## Testing

- Main/preload tests verify exact catalog shape, per-model statuses, and no secret fields.
- Pure App tests verify catalog merge, default selection, mismatch rows, and action eligibility.
- Playwright verifies every model row, URL and status changes, model-scoped save/clear/diagnose inputs, pending-model restart state, and no invalid status/mutation calls.
- Toast tests verify icon creation is deferred until the toaster-owned render callback.
- Package-specific type checks and the Enterprise Desktop build remain required.

## Non-Goals

- API keys are not added to `.env`.
- Public Server `HttpApi` and generated SDKs are not changed.
- Credentials are not shared automatically between models, even when their base URLs match.
- The feature branch is not merged into `enterprise-pilot` in this work.
