# Enterprise Provider and Model CRUD Design

## Goal

Allow SFMI Enterprise users to create, inspect, update, and delete user-global OpenAI-compatible providers and models from the settings UI. Packaged Company LLM entries become editable seed data rather than immutable policy, and users may register any validated HTTP(S) endpoint.

## Decisions

- Apply the feature only to SFMI Enterprise.
- Support OpenAI-compatible APIs through `@ai-sdk/openai-compatible` only.
- Permit arbitrary absolute HTTP(S) provider URLs while rejecting embedded credentials, queries, and fragments and continuing to reject provider redirects.
- Store the catalog per Windows user and share it across all projects.
- Store credentials per provider, not per model.
- Allow packaged seed providers and models to be edited and deleted.
- Let users choose one default provider/model pair.
- Keep provider and model IDs immutable after creation; names, URLs, models, credentials, and headers remain editable.

## Ownership and Persistence

Electron main owns the authoritative user-global catalog and all mutations.

`enterprise-providers.json` stores schema-versioned non-secret metadata:

- providers with immutable ID, editable name and Base URL;
- each provider's models with immutable ID and editable name;
- the selected default `providerID` and `modelID` when at least one model exists.

`enterprise-credentials.bin` stores provider-keyed API keys and custom headers encrypted with Windows DPAPI. Secret values never appear in catalog responses, config files, logs, diagnostics, or support exports.

Both stores use temporary files and atomic renames. Catalog or credential mutations are serialized. A mutation writes the candidate catalog and credentials, restarts the sidecar, and commits only after the sidecar becomes healthy. Restart failure restores both stores and restarts the last known-good configuration. Recovery restart failure enters the existing Enterprise recovery experience.

## Initial Seed and Migration

On the first run without a user catalog, the packaged Enterprise model profile seeds editable user data.

The legacy format associates a Base URL and credentials with each model, while the new format associates both with a provider. To avoid routing a legacy model through the wrong endpoint or credentials, each legacy model becomes an independent provider:

- the legacy default model uses provider ID `company-llm`, preserving the default reference;
- remaining providers receive stable, unique `company-llm-N` IDs in packaged order;
- legacy model IDs, names, Base URLs, and model-specific credentials are preserved;
- the legacy default model becomes the new default provider/model pair.

Historical messages remain unchanged. A project or session selection that no longer resolves after migration or later deletion switches to the current default before its next request and informs the user.

## Runtime Configuration and Trust Boundary

Electron passes the validated catalog and decrypted provider credentials to the utility-process sidecar during startup. Plaintext credentials remain confined to this in-memory startup and provider-request path.

Enterprise configuration materializes the catalog as OpenAI-compatible providers and models. After ordinary global and project config merging, Enterprise enforcement reconstructs these fields from the authoritative catalog:

- only catalog provider/model pairs remain enabled;
- every provider uses `@ai-sdk/openai-compatible`;
- Base URLs come from the catalog and cannot be replaced by project config;
- project config cannot add an unregistered provider or model;
- registered arbitrary HTTP(S) endpoints are allowed without the packaged-origin restriction;
- provider HTTP redirects remain disabled.

Public Server `HttpApi`, Protocol types, and generated SDKs do not change. Management is exposed only through typed Electron IPC and preload APIs.

## Management Interfaces and Validation

The Enterprise desktop bridge supports:

- reading the redacted catalog;
- creating, updating, and deleting providers;
- creating, updating, and deleting models;
- selecting the default provider/model pair;
- replacing or clearing a provider's credentials;
- testing a selected provider/model connection through the existing sidecar diagnostic path.

Electron main validates every mutation, regardless of renderer validation:

- provider IDs use lowercase letters, digits, hyphens, and underscores and are unique;
- model IDs are non-empty and unique within a provider;
- IDs cannot change during update operations;
- provider names, model names, and Base URLs are non-empty;
- Base URLs are absolute HTTP(S) URLs without embedded credentials, query strings, or fragments;
- header names and values are non-empty, with header-name uniqueness checked case-insensitively;
- a default must reference an existing provider/model pair.

Providers may contain zero models. Such providers cannot be selected as default or connection-tested until a model exists.

The renderer receives only credential state and configured header names. Existing secret values are never returned. Credential editing provides explicit preserve, complete replacement, and complete removal actions.

## Settings Experience

The existing single Company LLM settings row becomes a provider-management list. Each provider row shows its name, Base URL, model count, credential state, and default model where applicable, with Edit, Delete, and Test connection actions.

The add/edit experience supports provider metadata, provider-scoped API key and headers, and individual model creation, name updates, and deletion. Provider and model IDs are read-only after creation. Model rows expose a Set default action.

Deleting a provider requires confirmation and removes its models and encrypted credentials. Deleting a model also requires confirmation but does not alter historical messages. If the default model is deleted, the app chooses the first remaining model in the same provider and then the first model in catalog order. If no models remain, the default is unset, chat input is disabled, and the user is linked to provider settings.

Save, delete, default selection, credential mutation, and connection testing disable conflicting actions while pending. Success and failure are reported with accessible status text and toasts. Validation errors remain attached to their fields.

## Error Handling

- Invalid input is rejected before persistence and mapped to the relevant form field.
- Encryption unavailable or corrupt credential storage blocks secret mutations while leaving non-secret catalog metadata visible.
- File-write failure leaves the last durable files unchanged.
- Sidecar restart failure rolls back catalog and credentials together.
- Rollback recovery failure enters the existing Enterprise recovery path rather than reporting a false success.
- Diagnostic and support output redact API keys and custom header values.

## Testing and Acceptance

Desktop tests cover first-run seed, legacy credential migration, CRUD, default fallback, atomic persistence, serialized mutations, DPAPI failures, restart rollback, and recovery failure. IPC and preload tests verify exact method contracts, validation, immutable IDs, and secret-free responses.

OpenCode tests prove that registered arbitrary HTTP(S) endpoints work, project config cannot inject or redirect providers, the OpenAI-compatible package is forced, redirects remain blocked, and deleted selections fall back to the default.

App unit and browser tests cover empty state, provider/model creation and editing, confirmation-based deletion, default selection, credential preserve/replace/clear, pending-state locking, and error presentation. Playwright covers the full create-model-default-credentials-diagnostic flow, restart persistence, deletion fallback, and chat disablement when the catalog has no models.

Verification runs package-local tests and `bun typecheck` from `packages/desktop`, `packages/app`, and `packages/opencode`, followed by the Enterprise Desktop build.

The feature is accepted when a user can manage providers and models entirely from settings, use the resulting catalog across all projects without restarting the desktop app manually, preserve secret boundaries, prevent project-config bypass, and recover the last known-good state after a failed mutation.

## Non-Goals

- Non-Enterprise OpenCode provider management does not change.
- Anthropic, Google, or other non-OpenAI-compatible provider protocols are not supported.
- Provider/model catalogs are not synchronized between Windows users or machines.
- IDs are not renamed in place.
- A central administrator catalog, packaged-origin enforcement, and immutable provider policy are not retained for user-created endpoints in this feature.
