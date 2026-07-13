# Company LLM Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a first-class Company LLM setup flow with DPAPI-backed credentials and diagnostics that exercise the real OpenAI-compatible adapter.

**Architecture:** Electron main owns encrypted credential persistence and sends decrypted values in the utility-process startup message, never in the child environment. The sidecar stores them in a private provider module before starting the server; provider resolution applies them only while constructing the Company LLM adapter. The shared app exposes a Company LLM setup surface only when the desktop platform reports enterprise mode.

**Tech Stack:** Electron `safeStorage`, Node filesystem APIs, Bun tests, Effect, AI SDK, `@ai-sdk/openai-compatible`, Effect HttpApi, SolidJS.

## Global Constraints

- Complete `2026-07-13-enterprise-offline-foundation.md` first.
- API keys and secret headers must not be stored in project configuration, logs, or diagnostic output.
- Windows credential encryption uses Electron `safeStorage`, which is backed by Windows DPAPI.
- TLS verification uses the Windows trust store; do not add an insecure certificate bypass.
- Diagnostics must resolve the same config, auth, provider, and model adapter used by chat.
- The `Company LLM` provider ID is `company-llm`.
- Provider URLs remain restricted by the enterprise origin policy.
- Public Protocol or Server `HttpApi` changes require `bun run generate` from `packages/client`.
- Run tests and `bun typecheck` from package directories.

---

### Task 1: Add DPAPI-backed enterprise credential storage

**Files:**
- Create: `packages/desktop/src/main/enterprise-credentials.ts`
- Create: `packages/desktop/src/main/enterprise-credentials.test.ts`

**Interfaces:**
- Produces: `EnterpriseCredentials = { apiKey?: string; headers: Record<string, string> }`.
- Produces: `createEnterpriseCredentialStore(input)` with `get`, `set`, and `clear` methods.
- Consumed by Task 2 before every local sidecar spawn.

- [ ] **Step 1: Write failing encrypted persistence tests**

```ts
// packages/desktop/src/main/enterprise-credentials.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createEnterpriseCredentialStore } from "./enterprise-credentials"

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))

describe("enterprise credential store", () => {
  test("persists only encrypted bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
      decrypt: (value) => value.toString("utf8").split("").reverse().join(""),
    })

    await store.set({ apiKey: "secret-key", headers: { "X-Company-Token": "secret-header" } })
    const raw = await readFile(file, "utf8")
    expect(raw).not.toContain("secret-key")
    expect(raw).not.toContain("secret-header")
    expect(await store.get()).toEqual({ apiKey: "secret-key", headers: { "X-Company-Token": "secret-header" } })
  })

  test("refuses plaintext fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const store = createEnterpriseCredentialStore({
      file: join(dir, "credentials.bin"),
      encryptionAvailable: () => false,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
    })
    await expect(store.set({ apiKey: "secret", headers: {} })).rejects.toThrow("secure storage is unavailable")
  })

  test("treats an unreadable encrypted blob as unconfigured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    await Bun.write(file, "corrupt")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: () => { throw new Error("DPAPI decrypt failed") },
    })
    expect(await store.get()).toEqual({ headers: {} })
  })

  test("clear removes all credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const store = createEnterpriseCredentialStore({
      file: join(dir, "credentials.bin"),
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value, "utf8"),
      decrypt: (value) => value.toString("utf8"),
    })
    await store.set({ apiKey: "secret", headers: {} })
    await store.clear()
    expect(await store.get()).toEqual({ headers: {} })
  })
})
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run from `packages/desktop`:

```bash
bun test src/main/enterprise-credentials.test.ts
```

Expected: FAIL because `enterprise-credentials.ts` does not exist.

- [ ] **Step 3: Implement encrypted, atomic persistence**

```ts
// packages/desktop/src/main/enterprise-credentials.ts
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export type EnterpriseCredentials = {
  apiKey?: string
  headers: Record<string, string>
}

type Input = {
  file: string
  encryptionAvailable: () => boolean
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
}

export function createEnterpriseCredentialStore(input: Input) {
  const get = async (): Promise<EnterpriseCredentials> => {
    const encrypted = await readFile(input.file).catch(() => undefined)
    if (!encrypted) return { headers: {} }
    const value: unknown = await Promise.resolve(encrypted)
      .then(input.decrypt)
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    if (!value || typeof value !== "object") return { headers: {} }
    const record = value as { apiKey?: unknown; headers?: unknown }
    const headers =
      record.headers && typeof record.headers === "object"
        ? Object.fromEntries(
            Object.entries(record.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {}
    return { ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}), headers }
  }

  const set = async (credentials: EnterpriseCredentials) => {
    if (!input.encryptionAvailable()) throw new Error("Windows secure storage is unavailable")
    await mkdir(dirname(input.file), { recursive: true })
    const temp = `${input.file}.tmp`
    await writeFile(temp, input.encrypt(JSON.stringify(credentials)), { mode: 0o600 })
    await rename(temp, input.file)
  }

  const clear = () => rm(input.file, { force: true })
  return { get, set, clear }
}
```

- [ ] **Step 4: Run credential tests and desktop typecheck**

Run from `packages/desktop`:

```bash
bun test src/main/enterprise-credentials.test.ts
bun typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit credential storage**

```bash
git add packages/desktop/src/main/enterprise-credentials.ts packages/desktop/src/main/enterprise-credentials.test.ts
git commit -m "feat(desktop): encrypt enterprise credentials"
```

### Task 2: Bridge secure credentials into the sidecar lifecycle

**Files:**
- Modify: `packages/desktop/src/main/server.ts`
- Modify: `packages/desktop/src/main/sidecar.ts`
- Modify: `packages/desktop/src/main/env.d.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/desktop/src/renderer/index.tsx`
- Modify: `packages/app/src/context/platform.tsx`
- Create: `packages/desktop/src/main/enterprise-sidecar-env.test.ts`
- Modify: `packages/desktop/src/main/enterprise-credentials.ts`
- Modify: `packages/opencode/src/auth/index.ts`
- Modify: `packages/opencode/test/auth/auth.test.ts`
- Modify: `packages/opencode/src/config/enterprise.ts`
- Modify: `packages/opencode/src/provider/provider.ts`
- Create: `packages/opencode/src/provider/enterprise.ts`
- Modify: `packages/opencode/src/node.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts`
- Modify: `packages/opencode/test/config/enterprise.test.ts`
- Modify: `packages/opencode/test/provider/provider.test.ts`
- Create: `packages/opencode/test/provider/enterprise.test.ts`

**Interfaces:**
- Produces: `enterpriseSidecarEnvironment(): Record<string, string>` with empty standard auth/config overrides.
- Produces: `Platform.enterprise.credentials` methods `status`, `set`, and `clear`.
- Constraint: updating credentials returns `restartRequired: true`; the setup UI restarts the desktop so the next sidecar receives decrypted values.
- Constraint: enterprise sidecar `Auth.set` and `Auth.remove` reject writes, making the DPAPI file the only credential persistence path.
- Constraint: enterprise config/provider API responses remove `key`, `apiKey`, and secret header values before data reaches the renderer.
- Constraint: decrypted credentials are absent from `process.env`, so project shell commands cannot inherit them.

- [ ] **Step 1: Write a failing secret-environment test**

```ts
// packages/desktop/src/main/enterprise-sidecar-env.test.ts
import { expect, test } from "bun:test"
import { enterpriseSidecarEnvironment } from "./enterprise-credentials"

test("sidecar environment blocks shared plaintext credential sources", () => {
  expect(enterpriseSidecarEnvironment()).toEqual({
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: "{}",
  })
})
```

Create `packages/opencode/test/provider/enterprise.test.ts`:

```ts
import { expect, test } from "bun:test"
import { ProviderEnterprise } from "@/provider/enterprise"
import { ProviderV2 } from "@opencode-ai/core/provider"

test("applies enterprise credentials only to the company provider", () => {
  ProviderEnterprise.setCredentials({
    apiKey: "secret-key",
    headers: { "X-Company-Token": "secret-header" },
  })
  expect(
    ProviderEnterprise.options(
      ProviderV2.ID.make("company-llm"),
      { baseURL: "https://llm.corp.example/v1" },
    ),
  ).toEqual({
    baseURL: "https://llm.corp.example/v1",
    apiKey: "secret-key",
    headers: { "X-Company-Token": "secret-header" },
  })
  expect(ProviderEnterprise.options(ProviderV2.ID.make("other"), {})).toEqual({})
  ProviderEnterprise.setCredentials({ headers: {} })
})
```

Add `test` to the existing `bun:test` import in `packages/opencode/test/auth/auth.test.ts`, then add:

```ts
test("disables plaintext auth persistence in enterprise mode", () => {
  expect(Auth.persistenceEnabled({ OPENCODE_ENTERPRISE_OFFLINE: "1" })).toBe(false)
  expect(Auth.persistenceEnabled({})).toBe(true)
})
```

Add response-redaction tests:

```ts
// packages/opencode/test/config/enterprise.test.ts
test("enterprise public config removes secret provider options", () => {
  const result = ConfigEnterprise.publicInfo(
    {
      provider: {
        "company-llm": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://llm.corp.example/v1",
            apiKey: "secret-key",
            headers: { Authorization: "secret-header" },
          },
        },
      },
    },
    { enabled: true, defaultsPath: undefined, allowedOrigins: new Set(["https://llm.corp.example"]) },
  )
  expect(result.provider?.["company-llm"]?.options).toEqual({ baseURL: "https://llm.corp.example/v1" })
})
```

```ts
// packages/opencode/test/provider/provider.test.ts
test("public provider info can redact runtime credentials", () => {
  const result = Provider.toPublicInfo(
    {
      id: ProviderV2.ID.make("company-llm"),
      name: "Company LLM",
      source: "api",
      env: [],
      key: "secret-key",
      options: { baseURL: "https://llm.corp.example/v1", apiKey: "secret-key", headers: { Authorization: "secret-header" } },
      models: {},
    },
    { redactSecrets: true },
  )
  expect(JSON.stringify(result)).not.toContain("secret-key")
  expect(JSON.stringify(result)).not.toContain("secret-header")
  expect(result.options.baseURL).toBe("https://llm.corp.example/v1")
})
```

- [ ] **Step 2: Run the test and verify the missing export failure**

Run from `packages/desktop`:

```bash
bun test src/main/enterprise-sidecar-env.test.ts
```

Run from `packages/opencode`:

```bash
bun test test/auth/auth.test.ts test/config/enterprise.test.ts test/provider/enterprise.test.ts test/provider/provider.test.ts --filter "plaintext auth persistence|public config|enterprise credentials|public provider info"
```

Expected: both commands FAIL because the sidecar environment, in-memory provider credential store, auth persistence gate, and redaction helpers are absent.

- [ ] **Step 3: Add the private startup payload and safe sidecar environment**

Append to `enterprise-credentials.ts`:

```ts
export function enterpriseSidecarEnvironment(): Record<string, string> {
  return {
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: "{}",
  }
}
```

The two empty standard variables prevent fallback to plaintext `auth.json` and stale parent config. Actual secrets are not placed in the child environment.

Create `packages/opencode/src/provider/enterprise.ts` with the repository's self-export pattern. Define a synchronous Effect `Schema` decoder for `{ apiKey?: string; headers: Record<string, string> }`, and export:

```ts
export function options(
  providerID: ProviderV2.ID,
  current: Record<string, unknown>,
) {
  if (providerID !== ProviderV2.ID.make("company-llm")) return current
  return {
    ...current,
    ...(currentCredentials.apiKey ? { apiKey: currentCredentials.apiKey } : {}),
    ...(Object.keys(currentCredentials.headers).length
      ? { headers: { ...(isRecord(current.headers) ? current.headers : {}), ...currentCredentials.headers } }
      : {}),
  }
}
```

The module keeps `currentCredentials` private and exports `setCredentials(input: unknown)`, decoding with `Schema.decodeUnknownOption` and falling back to `{ headers: {} }` without logging. Import the existing `isRecord` utility. In `Provider.resolveSDK`, replace the initial options copy with `ProviderEnterprise.options(model.providerID, { ...provider.options })` so secrets are applied only immediately before constructing the bundled OpenAI-compatible SDK. The secret overlay wins over project headers, and provider/config list responses never see it.

Export `ProviderEnterprise` from `packages/opencode/src/node.ts` and add its `setCredentials` type to the `virtual:opencode-server` declaration in desktop `main/env.d.ts`. Add `credentials?: EnterpriseCredentials` to `SpawnLocalServerOptions` and include it only in the existing `child.postMessage({ type: "start", ... })` payload, never in `utilityProcess.fork(...).env`.

Extend sidecar `StartCommand` with `credentials?: unknown`. In `start`, dynamically import `{ ProviderEnterprise, Server }`, call `ProviderEnterprise.setCredentials(command.credentials)` before `Server.listen`, and then discard the command reference. `parseCommand` passes the unknown credential payload through for schema decoding but never serializes or logs it.

Export this pure helper from `packages/opencode/src/auth/index.ts`:

```ts
export function persistenceEnabled(env: Record<string, string | undefined> = process.env) {
  return env.OPENCODE_ENTERPRISE_OFFLINE !== "1"
}
```

At the start of both `Auth.set` and `Auth.remove`, fail with `AuthError({ message: "Auth persistence is disabled in this build" })` when the helper returns false. Reading `OPENCODE_AUTH_CONTENT` remains enabled. Do not create or update `auth.json` in that branch.

Add `ConfigEnterprise.publicInfo(info, policy: EnforcementPolicy = settings())`. When enterprise mode is disabled, return `info` unchanged. When enabled, copy each provider, delete provider option `apiKey`/`headers`, and delete every model's `headers` plus model option `apiKey`/`headers`. Preserve non-secret fields such as `baseURL`, model metadata, and generation options, and do not mutate the internal config object.

Extend `Provider.toPublicInfo(provider, options = {})` with `{ redactSecrets?: boolean }`. Preserve its existing JSON-safe conversion, then when redaction is requested delete provider `key`, provider option `apiKey`/`headers`, and every model's `headers` plus model option `apiKey`/`headers`. Do not mutate the internal provider object.

Use `ConfigEnterprise.publicInfo` for `config.get`, the return value of `config.update`, `global.config.get`, and the return value of `global.config.update`. In provider and config-provider handlers, call `Provider.toPublicInfo` with redaction enabled when `ConfigEnterprise.settings().enabled`. Internal provider execution and diagnostics continue using unredacted service values.

Add `env?: Record<string, string>` to `SpawnLocalServerOptions`. Change `createSidecarEnv()` to `createSidecarEnv(overrides = {})`, delete any inherited `OPENCODE_ENTERPRISE_CREDENTIALS`, and spread `overrides` after the inherited environment. Pass `options.env` from `spawnLocalServer`. Export the pure environment merge helper and extend `enterprise-sidecar-env.test.ts` with a case proving an inherited `OPENCODE_ENTERPRISE_CREDENTIALS` value is removed while the two empty standard overrides win.

After `app.whenReady()` in `src/main/index.ts`, create the production store:

```ts
const enterpriseCredentials = createEnterpriseCredentialStore({
  file: join(app.getPath("userData"), "enterprise-credentials.bin"),
  encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
})
```

Load credentials before `spawnLocalServer` and pass:

```ts
env: ENTERPRISE_ENABLED ? enterpriseSidecarEnvironment() : undefined,
credentials: ENTERPRISE_ENABLED ? await enterpriseCredentials.get() : undefined,
```

- [ ] **Step 4: Add typed IPC and platform methods**

Add to `ElectronAPI` in `src/preload/types.ts`:

```ts
enterprise: {
  enabled: boolean
  credentialStatus: () => Promise<{ configured: boolean }>
  setCredentials: (input: { apiKey?: string; headers?: Record<string, string> }) => Promise<{ restartRequired: true }>
  clearCredentials: () => Promise<{ restartRequired: true }>
}
```

Expose matching `ipcRenderer.invoke` calls in preload. Add dependencies and handlers in `registerIpcHandlers` that return `{ configured: Boolean(apiKey || header count) }`, call `clear`, and update credentials without reading secrets into the renderer. The `setCredentials` handler loads the current encrypted value and preserves `current.apiKey` or `current.headers` when the corresponding submitted field is absent; a non-empty submitted header map replaces the previous map. This lets a user update either credential kind without unknowingly clearing the other. `clearCredentials` remains the explicit remove-all action. Register no-op disabled responses for ordinary builds.

Add to `PlatformBase` in `packages/app/src/context/platform.tsx`:

```ts
enterprise?: {
  credentialStatus(): Promise<{ configured: boolean }>
  setCredentials(input: { apiKey?: string; headers?: Record<string, string> }): Promise<{ restartRequired: true }>
  clearCredentials(): Promise<{ restartRequired: true }>
}
```

Map `window.api.enterprise` into the desktop platform only when `ENTERPRISE_ENABLED` is true.

- [ ] **Step 5: Run IPC-adjacent tests and typechecks**

Run from `packages/desktop`:

```bash
bun test src/main/enterprise-credentials.test.ts src/main/enterprise-sidecar-env.test.ts src/main/index.test.ts
bun typecheck
```

Run from `packages/app`:

```bash
bun typecheck
```

Run from `packages/opencode`:

```bash
bun test test/auth/auth.test.ts test/config/enterprise.test.ts test/provider/enterprise.test.ts test/provider/provider.test.ts --filter "plaintext auth persistence|public config|enterprise credentials|public provider info"
bun typecheck
```

Expected: tests PASS and all three typechecks exit 0.

- [ ] **Step 6: Commit the credential bridge**

```bash
git add packages/desktop/src/main/server.ts packages/desktop/src/main/sidecar.ts packages/desktop/src/main/env.d.ts packages/desktop/src/main/index.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.ts packages/desktop/src/renderer/index.tsx packages/app/src/context/platform.tsx packages/desktop/src/main/enterprise-sidecar-env.test.ts packages/desktop/src/main/enterprise-credentials.ts packages/opencode/src/auth/index.ts packages/opencode/src/config/enterprise.ts packages/opencode/src/node.ts packages/opencode/src/provider/enterprise.ts packages/opencode/src/provider/provider.ts packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts packages/opencode/test/auth/auth.test.ts packages/opencode/test/config/enterprise.test.ts packages/opencode/test/provider/enterprise.test.ts packages/opencode/test/provider/provider.test.ts
git commit -m "feat(desktop): bridge enterprise credentials"
```

### Task 3: Add real provider diagnostics to the sidecar API

**Files:**
- Create: `packages/opencode/src/provider/diagnostic.ts`
- Create: `packages/opencode/test/provider/diagnostic.test.ts`
- Modify: `packages/opencode/src/effect/app-runtime.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Regenerate: `packages/client/src/generated/**`
- Regenerate: `packages/client/src/generated-effect/**`

**Interfaces:**
- Produces: `ProviderDiagnostic.Input` with `modelID` and `checkToolCall`.
- Produces: `ProviderDiagnostic.Result` with check states and a classified failure.
- Produces: authenticated endpoint `POST /provider/:providerID/diagnostics` with identifier `provider.diagnose`.

- [ ] **Step 1: Write failing classification and OpenAI-compatible probe tests**

```ts
// packages/opencode/test/provider/diagnostic.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { ProviderDiagnostic } from "@/provider/diagnostic"

const servers: Bun.Server<undefined>[] = []
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)))

describe("provider diagnostics", () => {
  test("classifies auth and model HTTP failures", () => {
    expect(ProviderDiagnostic.classify({ statusCode: 401, message: "Unauthorized" })).toBe("auth")
    expect(ProviderDiagnostic.classify({ statusCode: 403, message: "Forbidden" })).toBe("auth")
    expect(ProviderDiagnostic.classify({ statusCode: 404, message: "model not found" })).toBe("model")
    expect(ProviderDiagnostic.classify({ message: "ECONNREFUSED" })).toBe("connection")
    expect(ProviderDiagnostic.classify({ message: "ENOTFOUND" })).toBe("dns")
    expect(ProviderDiagnostic.classify({ message: "CERT_AUTHORITY_INVALID" })).toBe("tls")
    expect(ProviderDiagnostic.classify({ message: "request timed out" })).toBe("timeout")
    expect(ProviderDiagnostic.classify({ message: "invalid stream chunk", stage: "streaming" })).toBe("stream")
    expect(ProviderDiagnostic.classify({ message: "Tool call was not returned", stage: "toolCall" })).toBe("tool_call")
  })

  test("checks basic response and streaming through the real adapter", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { stream?: boolean }
        if (!body.stream) {
          return Response.json({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "company-code",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        }
        const stream = [
          'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"company-code","choices":[{"index":0,"delta":{"content":"O"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"company-code","choices":[{"index":0,"delta":{"content":"K"},"finish_reason":"stop"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n")
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      },
    })
    servers.push(server)
    const sdk = createOpenAICompatible({ baseURL: `${server.url}v1`, apiKey: "test" })
    const result = await ProviderDiagnostic.probe(sdk("company-code"), false)
    expect(result.checks.basic).toBe("pass")
    expect(result.checks.streaming).toBe("pass")
  })
})
```

- [ ] **Step 2: Run the diagnostic test and verify failure**

Run from `packages/opencode`:

```bash
bun test test/provider/diagnostic.test.ts
```

Expected: FAIL because `ProviderDiagnostic` does not exist.

- [ ] **Step 3: Implement diagnostic schemas, probe, and service**

Create `provider/diagnostic.ts` with:

```ts
export * as ProviderDiagnostic from "./diagnostic"

import { Provider } from "./provider"
import { APICallError, generateText, jsonSchema, streamText, tool } from "ai"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const Input = Schema.Struct({
  modelID: ModelV2.ID,
  checkToolCall: Schema.Boolean,
})
export const FailureKind = Schema.Literals([
  "connection",
  "dns",
  "tls",
  "timeout",
  "auth",
  "model",
  "response",
  "stream",
  "tool_call",
])
export const Result = Schema.Struct({
  ok: Schema.Boolean,
  checks: Schema.Struct({
    basic: Schema.Literals(["pass", "fail", "skipped"]),
    streaming: Schema.Literals(["pass", "fail", "skipped"]),
    toolCall: Schema.Literals(["pass", "fail", "skipped"]),
  }),
  failure: Schema.optional(Schema.Struct({ kind: FailureKind, message: Schema.String })),
})

type Stage = "basic" | "streaming" | "toolCall"
type ProbeError = { stage: Stage; cause: unknown }

export function classify(input: {
  statusCode?: number
  message: string
  stage?: Stage
}): typeof FailureKind.Type {
  const message = input.message.toLowerCase()
  if (input.statusCode === 401 || input.statusCode === 403) return "auth"
  if (message.includes("model not found") || message.includes("unknown model")) return "model"
  if (message.includes("cert_") || message.includes("certificate")) return "tls"
  if (message.includes("timed out") || message.includes("timeout") || message.includes("aborted")) return "timeout"
  if (message.includes("enotfound") || message.includes("eai_again")) return "dns"
  if (message.includes("econnrefused") || message.includes("econnreset") || message.includes("fetch failed")) return "connection"
  if (input.stage === "streaming") return "stream"
  if (input.stage === "toolCall") return "tool_call"
  return "response"
}

const messages: Record<typeof FailureKind.Type, string> = {
  connection: "Cannot reach the Company LLM endpoint. Check the service and network route.",
  dns: "The Company LLM hostname cannot be resolved. Check corporate DNS.",
  tls: "TLS validation failed. Install the company CA in the Windows trust store.",
  timeout: "The Company LLM request timed out. Check service load and network latency.",
  auth: "Authentication failed (HTTP 401/403). Update the stored company credentials.",
  model: "The configured model is unavailable. Check the project model ID.",
  response: "The endpoint returned an incompatible OpenAI-style response.",
  stream: "The endpoint did not return a compatible streaming response.",
  tool_call: "The configured model did not return the requested tool call.",
}

async function check(stage: Stage, run: () => Promise<void>) {
  try {
    await run()
  } catch (cause) {
    throw { stage, cause } satisfies ProbeError
  }
}

function isProbeError(error: unknown): error is ProbeError {
  return Boolean(error && typeof error === "object" && "stage" in error && "cause" in error)
}

function causeChain(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (seen.has(error)) return []
  seen.add(error)
  if (!error || typeof error !== "object" || !("cause" in error)) return [error]
  return [error, ...causeChain(error.cause, seen)]
}

function failed(error: unknown): typeof Result.Type {
  const stage = isProbeError(error) ? error.stage : "basic"
  const cause = isProbeError(error) ? error.cause : error
  const chain = causeChain(cause)
  const api = chain.find((item) => APICallError.isInstance(item))
  const statusCode = APICallError.isInstance(api) ? api.statusCode : undefined
  const message = chain.map((item) => item instanceof Error ? item.message : String(item)).join(" ")
  const kind = chain.some((item) => Provider.ModelNotFoundError.isInstance(item))
    ? "model"
    : classify({ statusCode, message, stage })
  return {
    ok: false,
    checks: {
      basic: stage === "basic" ? "fail" : "pass",
      streaming: stage === "basic" ? "skipped" : stage === "streaming" ? "fail" : "pass",
      toolCall: stage === "toolCall" ? "fail" : "skipped",
    },
    failure: { kind, message: messages[kind] },
  }
}

export async function probe(model: Parameters<typeof generateText>[0]["model"], checkToolCall: boolean) {
  await check("basic", async () => {
    const result = await generateText({ model, prompt: "Reply with OK.", maxOutputTokens: 8, abortSignal: AbortSignal.timeout(15_000) })
    if (!result.text.trim()) throw new Error("Basic response was empty")
  })
  await check("streaming", async () => {
    const stream = streamText({ model, prompt: "Reply with OK.", maxOutputTokens: 8, abortSignal: AbortSignal.timeout(15_000) })
    const chunks: string[] = []
    for await (const chunk of stream.textStream) chunks.push(chunk)
    if (!chunks.join("").trim()) throw new Error("Streaming response was empty")
  })
  if (checkToolCall) {
    await check("toolCall", async () => {
      const result = await generateText({
        model,
        prompt: "Call the enterprise_probe tool once.",
        toolChoice: "required",
        tools: {
          enterprise_probe: tool({ inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }) }),
        },
        abortSignal: AbortSignal.timeout(15_000),
      })
      if (result.toolCalls.length === 0) throw new Error("Tool call was not returned")
    })
  }
  return {
    ok: true,
    checks: { basic: "pass" as const, streaming: "pass" as const, toolCall: checkToolCall ? "pass" as const : "skipped" as const },
  }
}

export interface Interface {
  readonly run: (providerID: ProviderV2.ID, input: typeof Input.Type) => Effect.Effect<typeof Result.Type>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderDiagnostic") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return Service.of({
      run: Effect.fn("ProviderDiagnostic.run")((providerID, input) =>
        Effect.gen(function* () {
          const model = yield* provider.getModel(providerID, input.modelID)
          const language = yield* provider.getLanguage(model)
          return yield* Effect.tryPromise({
            try: () => probe(language, input.checkToolCall),
            catch: (error) => error,
          })
        }).pipe(
          Effect.catchAll((error) => Effect.succeed(failed(error))),
        )
      ),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Provider.node] })
```

Register `ProviderDiagnostic.node` in the application runtime. The diagnostic response returns only the fixed corrective messages above; it must never return the raw provider exception, response body, request URL, API key, or secret headers.

- [ ] **Step 4: Add the authenticated HttpApi endpoint and handler**

Add to the provider group:

```ts
HttpApiEndpoint.post("diagnose", `${root}/:providerID/diagnostics`, {
  params: { providerID: ProviderV2.ID },
  query: WorkspaceRoutingQuery,
  payload: ProviderDiagnostic.Input,
  success: described(ProviderDiagnostic.Result, "Provider diagnostic result"),
}).annotateMerge(
  OpenApi.annotations({
    identifier: "provider.diagnose",
    summary: "Diagnose provider connection",
    description: "Test model response, streaming, and optional tool-call compatibility.",
  }),
)
```

Resolve `ProviderDiagnostic.Service` in `providerHandlers` and add:

```ts
const diagnose = Effect.fn("ProviderHttpApi.diagnose")((ctx: {
  params: { providerID: ProviderV2.ID }
  payload: typeof ProviderDiagnostic.Input.Type
}) => diagnostic.run(ctx.params.providerID, ctx.payload))
```

Finish the handler chain with `.handle("diagnose", diagnose)`. Add `ProviderDiagnostic.node` to the server runtime dependency graph.

- [ ] **Step 5: Regenerate clients and run provider/server verification**

Run from `packages/client`:

```bash
bun run generate
bun typecheck
```

Run from `packages/opencode`:

```bash
bun test test/provider/diagnostic.test.ts
bun typecheck
```

Expected: generation exits 0, diagnostic tests PASS, and both typechecks exit 0.

- [ ] **Step 6: Commit diagnostics and generated clients**

```bash
git add packages/opencode/src/provider/diagnostic.ts packages/opencode/test/provider/diagnostic.test.ts packages/opencode/src/effect/app-runtime.ts packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/client/src/generated packages/client/src/generated-effect
git commit -m "feat(opencode): add provider diagnostics"
```

### Task 4: Add the Company LLM setup surface

**Files:**
- Create: `packages/app/src/components/dialog-company-provider.tsx`
- Create: `packages/app/src/components/dialog-company-provider.test.ts`
- Modify: `packages/app/src/components/dialog-connect-provider.tsx`
- Modify: `packages/app/src/components/dialog-select-server.tsx`
- Modify: `packages/app/src/components/settings-providers.tsx`
- Modify: `packages/app/src/components/settings-v2/providers.tsx`
- Modify: `packages/app/src/pages/layout.tsx`
- Modify: `packages/app/src/context/platform.tsx`
- Modify: `packages/desktop/src/renderer/index.tsx`

**Interfaces:**
- Consumes: `Platform.enterprise`, `client.provider.diagnose`, and configured `company-llm` model data.
- Produces: a setup dialog that saves encrypted secrets, restarts when needed, and reports diagnostic checks.

- [ ] **Step 1: Extract and test setup-state behavior**

```ts
// packages/app/src/components/dialog-company-provider.test.ts
import { expect, test } from "bun:test"
import { companyProviderCredentialInput, companyProviderModels } from "./dialog-company-provider"

test("trims secrets without placing them in provider config", () => {
  expect(companyProviderCredentialInput(" secret ", [{ key: " X-Token ", value: " value " }])).toEqual({
    apiKey: "secret",
    headers: { "X-Token": "value" },
  })
})

test("omits untouched credential kinds so main can preserve encrypted values", () => {
  expect(companyProviderCredentialInput("", [{ key: "", value: "" }])).toEqual({})
})

test("reads configured company models", () => {
  expect(
    companyProviderModels({
      provider: { "company-llm": { models: { code: { name: "Company Code" } } } },
    }),
  ).toEqual([{ id: "code", name: "Company Code" }])
})
```

- [ ] **Step 2: Run the test and verify the missing component failure**

Run from `packages/app`:

```bash
bun test src/components/dialog-company-provider.test.ts
```

Expected: FAIL because `dialog-company-provider.tsx` does not exist.

- [ ] **Step 3: Build the Company LLM dialog**

Implement the pure exports and the component around this state and mutation boundary:

```tsx
type CompanyConfig = {
  provider?: Record<
    string,
    {
      options?: { baseURL?: unknown }
      models?: Record<string, { name?: string }>
    }
  >
}

type DiagnosticResult = {
  ok: boolean
  checks: {
    basic: "pass" | "fail" | "skipped"
    streaming: "pass" | "fail" | "skipped"
    toolCall: "pass" | "fail" | "skipped"
  }
  failure?: { kind: string; message: string }
}

export function companyProviderCredentialInput(apiKey: string, headers: { key: string; value: string }[]) {
  const values = Object.fromEntries(
    headers
      .map((header) => [header.key.trim(), header.value.trim()] as const)
      .filter((header) => header[0] && header[1]),
  )
  return {
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(Object.keys(values).length ? { headers: values } : {}),
  }
}

export function companyProviderModels(config: CompanyConfig) {
  return Object.entries(config.provider?.["company-llm"]?.models ?? {}).map(([id, model]) => ({
    id,
    name: model.name ?? id,
  }))
}

export function DialogCompanyProvider(props: { onBack: () => void }) {
  const platform = usePlatform()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [apiKey, setApiKey] = createSignal("")
  const [headers, setHeaders] = createStore([{ key: "", value: "" }])
  const models = createMemo(() => companyProviderModels(serverSync().data.config))
  const [modelID, setModelID] = createSignal(models()[0]?.id ?? "")
  const [checking, setChecking] = createSignal(false)
  const [result, setResult] = createSignal<DiagnosticResult>()

  createEffect(() => {
    if (modelID() || !models()[0]) return
    setModelID(models()[0].id)
  })

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const enterprise = platform.enterprise
    if (!enterprise) return
    await enterprise.setCredentials(companyProviderCredentialInput(apiKey(), headers))
    setApiKey("")
    await platform.restart()
  }

  const diagnose = async () => {
    if (!modelID() || checking()) return
    setChecking(true)
    const response = await serverSDK()
      .client.provider.diagnose({
        providerID: "company-llm",
        modelID: modelID(),
        checkToolCall: true,
      })
      .catch(() => undefined)
      .finally(() => setChecking(false))
    setResult(
      response?.data ?? {
        ok: false,
        checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
        failure: { kind: "connection", message: language.t("common.requestFailed") },
      },
    )
  }

  const clear = async () => {
    if (!platform.enterprise) return
    await platform.enterprise.clearCredentials()
    await platform.restart()
  }

  return (
    <Dialog title="Company LLM">
      <form class="flex flex-col gap-4 px-4 pb-4" onSubmit={save}>
        <TextField
          label="Base URL"
          value={String(serverSync().data.config.provider?.["company-llm"]?.options?.baseURL ?? "")}
          disabled
        />
        <label class="flex flex-col gap-1 text-12-medium text-text-weak">
          Model
          <select value={modelID()} onChange={(event) => setModelID(event.currentTarget.value)}>
            <For each={models()}>{(model) => <option value={model.id}>{model.name}</option>}</For>
          </select>
        </label>
        <TextField label="API key" type="password" value={apiKey()} onChange={setApiKey} />
        <For each={headers}>
          {(header, index) => (
            <div class="grid grid-cols-[1fr_1fr_auto] gap-2">
              <TextField label="Secret header" value={header.key} onChange={(value) => setHeaders(index(), "key", value)} />
              <TextField label="Secret value" type="password" value={header.value} onChange={(value) => setHeaders(index(), "value", value)} />
              <IconButton type="button" icon="trash" aria-label="Remove secret header" onClick={() => setHeaders((rows) => rows.filter((_, row) => row !== index()))} />
            </div>
          )}
        </For>
        <IconButton type="button" icon="plus" aria-label="Add secret header" onClick={() => setHeaders((rows) => [...rows, { key: "", value: "" }])} />
        <div class="flex gap-2">
          <Button type="submit" variant="primary">{language.t("common.save")}</Button>
          <Button type="button" variant="secondary" disabled={checking()} onClick={() => void diagnose()}>
            Test connection
          </Button>
          <Button type="button" variant="secondary" onClick={() => void clear()}>Clear credentials</Button>
          <Button type="button" variant="secondary" onClick={props.onBack}>{language.t("common.cancel")}</Button>
        </div>
        <Show when={result()}>
          {(diagnostic) => (
            <div class="grid grid-cols-[1fr_auto] gap-2 text-12-regular">
              <span>Basic response</span><span>{diagnostic().checks.basic}</span>
              <span>Streaming</span><span>{diagnostic().checks.streaming}</span>
              <span>Tool calling</span><span>{diagnostic().checks.toolCall}</span>
              <Show when={diagnostic().failure}>{(failure) => <><span>{failure().kind}</span><span>{failure().message}</span></>}</Show>
            </div>
          )}
        </Show>
      </form>
    </Dialog>
  )
}
```

Use the existing `TextField`, `Button`, `IconButton`, and `Dialog` imports, Solid `For`, `Show`, `createEffect`, `createMemo`, and `createSignal`, plus `createStore` from `solid-js/store`. Keep API key state local to the dialog and clear it before restart. Icon buttons include the shown accessible labels and existing tooltips.

- [ ] **Step 4: Make Company LLM the only enterprise provider setup entry**

In both provider settings implementations, branch on `platform.enterprise`. Enterprise mode renders one `Company LLM` row with the configured model name, connection status, `Configure`, and `Test connection` actions. Hide popular providers, `Show more providers`, OpenCode Zen, OAuth providers, and the generic custom-provider entry. Ordinary mode retains the existing tree unchanged.

Also branch at the top of the shared `DialogConnectProvider`: when `usePlatform().enterprise` is present, return `DialogCompanyProvider` instead of constructing `ProviderPicker`, `CustomProviderForm`, or `ProviderConnection`. This single boundary covers command-palette, model-picker, manage-models, usage-exceeded, and settings callers and prevents enterprise credentials from reaching the existing plaintext `client.auth.set(...)` path. Ordinary mode retains the current dialog unchanged.

Keep the pilot bound to its authenticated local sidecar. In `pages/layout.tsx`, do not register `server.switch` in enterprise mode. In `DialogSelectServer`, the enterprise branch displays only the current built-in sidecar and omits add-server, SSH, WSL, remove, and set-default controls. In the desktop renderer, make `effectiveDefaultServer()` return `ServerConnection.Key.make("sidecar")` in enterprise mode, expose only the sidecar in `servers()`, make `getDefaultServer()` return `sidecar`, and make `setDefaultServer()` reject changes with `Remote servers are disabled in this build`.

Use existing translated strings where they express the same action (`common.connect`, `common.save`, `common.cancel`, `common.requestFailed`). The fixed product label is `Company LLM` and diagnostic kind values come from the server result.

- [ ] **Step 5: Run app tests and typechecks**

Run from `packages/app`:

```bash
bun test src/components/dialog-company-provider.test.ts src/components/dialog-custom-provider.test.ts
bun typecheck
```

Run from `packages/desktop`:

```bash
bun typecheck
```

Expected: tests PASS and both typechecks exit 0.

- [ ] **Step 6: Commit the setup surface**

```bash
git add packages/app/src/components/dialog-company-provider.tsx packages/app/src/components/dialog-company-provider.test.ts packages/app/src/components/dialog-connect-provider.tsx packages/app/src/components/dialog-select-server.tsx packages/app/src/components/settings-providers.tsx packages/app/src/components/settings-v2/providers.tsx packages/app/src/context/platform.tsx packages/app/src/pages/layout.tsx packages/desktop/src/renderer/index.tsx
git commit -m "feat(app): add company llm setup"
```

### Task 5: Verify the complete Company LLM connection flow

**Files:**
- Verify only; no source changes expected.

**Interfaces:**
- Confirms secure storage, sidecar injection, provider resolution, diagnostics, generated clients, and UI compile together.

- [ ] **Step 1: Run all focused tests**

Run from `packages/desktop`:

```bash
bun test src/main/enterprise-credentials.test.ts src/main/enterprise-sidecar-env.test.ts
```

Run from `packages/opencode`:

```bash
bun test test/auth/auth.test.ts test/config/enterprise.test.ts test/provider/enterprise.test.ts test/provider/diagnostic.test.ts test/provider/provider.test.ts
```

Run from `packages/app`:

```bash
bun test src/components/dialog-company-provider.test.ts src/components/dialog-custom-provider.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run all changed-package typechecks**

Run `bun typecheck` separately from `packages/desktop`, `packages/opencode`, `packages/client`, and `packages/app`.

Expected: all four commands exit 0.

- [ ] **Step 3: Inspect secret handling**

```bash
rg -n "apiKey|X-Company-Token|OPENCODE_AUTH_CONTENT|OPENCODE_CONFIG_CONTENT" packages/desktop/src packages/app/src packages/opencode/src
```

Expected: secrets enter through dialog local state, encrypted credential storage, the utility-process startup message, and private `ProviderEnterprise` memory only. Child environments, config/auth API responses, project files, and logging calls contain no credential value.

- [ ] **Step 4: Record the connection checkpoint**

```bash
git status --short
git log -4 --oneline
```

Expected: no uncommitted source changes and the four task commits are visible.
