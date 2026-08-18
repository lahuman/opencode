# Empty Enterprise Catalog Design

## Goal

Allow a SFMI Enterprise desktop build to package zero initial providers and models. New users start in the existing empty-composer experience and register providers and models through Settings. An existing Windows user-global provider catalog remains authoritative and is never cleared merely because the packaged catalog is empty.

## Environment Contract

The supported empty-catalog configuration is:

```env
OPENCODE_ENTERPRISE=1
OPENCODE_ENTERPRISE_MODELS=[]
OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID=
OPENCODE_ENTERPRISE_ALLOWED_ORIGINS=
OPENCODE_ENTERPRISE_DEFAULTS_VERSION=dev-1
OPENCODE_ENTERPRISE_GUIDE_VERSION=sfmi-1
OPENCODE_ENTERPRISE_CATALOG_VERSION=dev-1
```

`OPENCODE_ENTERPRISE_MODELS=[]` is the explicit empty-catalog signal. When the array is empty, `OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID` may be omitted or blank. When the array contains models, the default model ID remains required and must reference one of them. The legacy single-model variables remain unchanged and still require a complete model.

## Profile and Package Manifest

The Enterprise profile keeps `defaultModelID` as a string so existing consumers and the manifest shape remain stable. Its value is the empty string only when `models` is empty.

Manifest schema version 2 remains unchanged. It accepts exactly two valid catalog states:

- one or more model IDs and a non-empty default contained in that list;
- zero model IDs and an empty default model ID.

The manifest continues to hash `models.json` and all packaged Enterprise resources. Empty models therefore remain integrity-checked rather than bypassing preflight.

## Catalog Initialization and Persistence

Catalog initialization remains read-before-seed:

1. Read the Windows user-global provider catalog.
2. If it exists and is valid, return it unchanged regardless of the packaged model list.
3. If it does not exist and the packaged list is empty, persist a schema-v1 catalog with no providers and no default.
4. If packaged models exist, preserve the current migration and seeding behavior.

No startup path deletes an existing catalog because the package has zero models. The existing provider runtime assigns the first newly created model as the default, so no additional UI behavior is required.

## Sidecar and Empty State

The sidecar receives an empty authoritative catalog and empty provider-scoped credentials on a fresh installation. OpenCode materializes no providers and no model default. The App uses the already implemented Enterprise empty-composer state: editing and submission are disabled, and `Manage providers` opens provider settings.

Allowed origins may be empty because user-configured OpenAI-compatible endpoints are contacted by the sidecar/runtime path, not directly by renderer code.

## Validation and Errors

- An empty JSON array is valid only through `OPENCODE_ENTERPRISE_MODELS=[]`.
- Invalid JSON, non-array JSON, duplicate model IDs, incomplete model metadata, and unsafe URLs remain errors.
- A non-empty default with an empty model list is rejected.
- A blank or missing default with a non-empty model list is rejected.
- Manifest states mixing an empty default with models, or a non-empty default with no models, are rejected.

## Testing

Tests cover:

- profile parsing for the valid empty pair and both invalid mixed states;
- environment serialization of the empty profile;
- manifest creation, decoding, and verification for zero models;
- existing manifest behavior for non-empty catalogs;
- first-launch initialization to an empty catalog;
- preservation of an existing user catalog when packaged models are empty;
- focused Desktop typecheck and Enterprise profile/preflight/provider suites.

## Compatibility

This is additive for JSON-array configuration. Existing non-empty Enterprise builds and legacy single-model `.env` configurations retain their current validation. No public Protocol or Server `HttpApi` changes and no generated SDK updates are required.
