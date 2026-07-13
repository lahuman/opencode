# Enterprise Offline Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows desktop enterprise build profile that starts offline, loads company defaults below user and project configuration, and limits model providers to packaged internal OpenAI-compatible endpoints.

**Architecture:** The desktop build injects one explicit enterprise profile into the main process before the local sidecar starts. The sidecar loads a packaged defaults file before global and project config, materializes build metadata into the parsed defaults as structured data, skips OpenCode remote config, applies final provider and plugin allowlists, and builds against a packaged offline model catalog without changing ordinary builds.

**Tech Stack:** Electron 42, electron-vite, Bun, TypeScript, Effect, SolidJS, existing OpenCode config/provider services.

## Global Constraints

- Target Windows 10 and Windows 11 x64.
- Preserve the Electron renderer and authenticated loopback sidecar.
- The ordinary `dev`, `beta`, and `prod` builds must retain existing behavior.
- Company defaults have lower priority than user global and project `opencode.jsonc` settings.
- Administrator-managed settings retain highest priority for adjustable fields; final build-level offline gates still apply.
- OpenCode cloud auth, public sharing, public model refresh, public updates, and public default plugins are non-overridable in the enterprise build.
- Public-registry plugins are removed after config merging; file-based project plugins remain available, but their dependencies must already be present locally.
- Project provider URLs may change only within packaged internal endpoint origins.
- Provider endpoint URLs must not contain embedded usernames or passwords; secrets use the DPAPI credential path.
- Do not add a new provider implementation; enterprise providers use `@ai-sdk/openai-compatible`.
- Run tests and `bun typecheck` from package directories, never the repository root.
- Do not edit generated client files directly.

---

### Task 1: Define and inject the desktop enterprise profile

**Files:**
- Create: `packages/desktop/src/enterprise.ts`
- Create: `packages/desktop/src/enterprise.test.ts`
- Modify: `packages/desktop/electron.vite.config.ts`
- Modify: `packages/desktop/src/main/env.d.ts`
- Modify: `packages/desktop/src/main/constants.ts`
- Modify: `packages/desktop/src/main/server.ts`
- Modify: `packages/desktop/src/main/index.ts`

**Interfaces:**
- Produces: `EnterpriseProfile` with `enabled`, `baseURL`, `modelID`, `modelName`, and `allowedOrigins`.
- Produces: `enterpriseEnvironment(profile, paths): Record<string, string>` for the sidecar process.
- Consumes in later tasks: `ENTERPRISE_PROFILE` and `ENTERPRISE_ENABLED` from `src/enterprise.ts`.

- [ ] **Step 1: Write profile parsing and environment tests**

```ts
// packages/desktop/src/enterprise.test.ts
import { describe, expect, test } from "bun:test"
import { enterpriseEnvironment, parseEnterpriseProfile } from "./enterprise"

describe("enterprise profile", () => {
  test("keeps ordinary builds disabled", () => {
    expect(parseEnterpriseProfile({ OPENCODE_ENTERPRISE: "0" })).toEqual({ enabled: false })
    expect(enterpriseEnvironment({ enabled: false }, { defaults: "", guide: "" })).toEqual({})
  })

  test("requires valid internal model settings", () => {
    expect(() =>
      parseEnterpriseProfile({
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_BASE_URL: "not-a-url",
        OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      }),
    ).toThrow("OPENCODE_ENTERPRISE_BASE_URL")
  })

  test("rejects non-HTTP allowed origins", () => {
    expect(() =>
      parseEnterpriseProfile({
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
        OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "file:///C:/tmp",
      }),
    ).toThrow("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS")
  })

  test("rejects credentials embedded in the provider URL", () => {
    expect(() =>
      parseEnterpriseProfile({
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_BASE_URL: "https://user:secret@llm.corp.example/v1",
        OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      }),
    ).toThrow("must not contain credentials")
  })

  test("injects non-overridable offline flags and packaged paths", () => {
    const profile = parseEnterpriseProfile({
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
      OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example,https://llm-dr.corp.example",
    })

    expect(enterpriseEnvironment(profile, { defaults: "C:/app/enterprise/opencode.jsonc", guide: "" })).toEqual({
      OPENCODE_ENTERPRISE_OFFLINE: "1",
      OPENCODE_ENTERPRISE_DEFAULTS_PATH: "C:/app/enterprise/opencode.jsonc",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example,https://llm-dr.corp.example",
      OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
      OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    })
  })
})
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run from `packages/desktop`:

```bash
bun test src/enterprise.test.ts
```

Expected: FAIL because `src/enterprise.ts` does not exist.

- [ ] **Step 3: Implement the pure enterprise profile module**

```ts
// packages/desktop/src/enterprise.ts
export type EnterpriseProfile =
  | { enabled: false }
  | {
      enabled: true
      baseURL: string
      modelID: string
      modelName: string
      allowedOrigins: string[]
    }

type BuildEnv = Record<string, string | undefined>

export function parseEnterpriseProfile(env: BuildEnv): EnterpriseProfile {
  if (env.OPENCODE_ENTERPRISE !== "1") return { enabled: false }

  const baseURL = env.OPENCODE_ENTERPRISE_BASE_URL?.trim()
  const modelID = env.OPENCODE_ENTERPRISE_MODEL_ID?.trim()
  const modelName = env.OPENCODE_ENTERPRISE_MODEL_NAME?.trim()
  if (!baseURL) throw new Error("OPENCODE_ENTERPRISE_BASE_URL is required")
  if (!modelID) throw new Error("OPENCODE_ENTERPRISE_MODEL_ID is required")
  if (!modelName) throw new Error("OPENCODE_ENTERPRISE_MODEL_NAME is required")

  const url = (() => {
    try {
      return new URL(baseURL)
    } catch {
      throw new Error("OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL")
    }
  })()
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL")
  }
  if (url.username || url.password) throw new Error("OPENCODE_ENTERPRISE_BASE_URL must not contain credentials")
  const origin = url.origin

  const allowedOrigins = Array.from(
    new Set([
      origin,
      ...(env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const url = new URL(item)
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain HTTP(S) origins")
          }
          if (url.username || url.password) {
            throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must not contain credentials")
          }
          return url.origin
        }),
    ]),
  )
  return { enabled: true, baseURL: url.toString(), modelID, modelName, allowedOrigins }
}

export function enterpriseEnvironment(
  profile: EnterpriseProfile,
  paths: { defaults: string; guide: string },
): Record<string, string> {
  if (!profile.enabled) return {}
  return {
    OPENCODE_ENTERPRISE_OFFLINE: "1",
    OPENCODE_ENTERPRISE_DEFAULTS_PATH: paths.defaults,
    OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: profile.allowedOrigins.join(","),
    OPENCODE_ENTERPRISE_BASE_URL: profile.baseURL,
    OPENCODE_ENTERPRISE_MODEL_ID: profile.modelID,
    OPENCODE_ENTERPRISE_MODEL_NAME: profile.modelName,
    ...(paths.guide ? { OPENCODE_ENTERPRISE_GUIDE_PATH: paths.guide } : {}),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  }
}

export const ENTERPRISE_PROFILE = parseEnterpriseProfile({
  OPENCODE_ENTERPRISE: import.meta.env.OPENCODE_ENTERPRISE,
  OPENCODE_ENTERPRISE_BASE_URL: import.meta.env.OPENCODE_ENTERPRISE_BASE_URL,
  OPENCODE_ENTERPRISE_MODEL_ID: import.meta.env.OPENCODE_ENTERPRISE_MODEL_ID,
  OPENCODE_ENTERPRISE_MODEL_NAME: import.meta.env.OPENCODE_ENTERPRISE_MODEL_NAME,
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: import.meta.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS,
})

export const ENTERPRISE_ENABLED = ENTERPRISE_PROFILE.enabled
```

Add the five `ImportMetaEnv` string properties in `src/main/env.d.ts`. In `electron.vite.config.ts`, define all five values for both `main` and `renderer` from `process.env`, using `"0"` and empty strings when absent. Export `ENTERPRISE_ENABLED` from `src/main/constants.ts` by importing it from `../enterprise`, and change updater eligibility to:

```ts
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && !ENTERPRISE_ENABLED
```

In `src/main/index.ts`, resolve enterprise resources before `preferAppEnv`:

```ts
const enterpriseDir = app.isPackaged
  ? join(process.resourcesPath, "enterprise")
  : join(import.meta.dirname, "../../resources/enterprise")

preferAppEnv(
  app.getPath("userData"),
  enterpriseEnvironment(ENTERPRISE_PROFILE, {
    defaults: join(enterpriseDir, "opencode.jsonc"),
    guide: join(enterpriseDir, "company-guide.md"),
  }),
)
```

Change `preferAppEnv` in `src/main/server.ts` to accept `overrides: Record<string, string> = {}` and spread `overrides` last into `process.env`.

- [ ] **Step 4: Run the focused test and desktop typecheck**

Run from `packages/desktop`:

```bash
bun test src/enterprise.test.ts
bun typecheck
```

Expected: all enterprise tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit the profile boundary**

```bash
git add packages/desktop/src/enterprise.ts packages/desktop/src/enterprise.test.ts packages/desktop/electron.vite.config.ts packages/desktop/src/main/env.d.ts packages/desktop/src/main/constants.ts packages/desktop/src/main/server.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): add enterprise offline profile"
```

### Task 2: Load enterprise defaults below user and project config

**Files:**
- Create: `packages/opencode/src/config/enterprise.ts`
- Modify: `packages/opencode/src/config/config.ts`
- Create: `packages/opencode/test/config/enterprise.test.ts`
- Modify: `packages/opencode/test/config/config.test.ts`
- Create: `packages/desktop/resources/enterprise/opencode.jsonc`

**Interfaces:**
- Produces: `ConfigEnterprise.settings()`, `ConfigEnterprise.materializeDefaults(info)`, and `ConfigEnterprise.enforce(info)`.
- Consumes: sidecar environment from Task 1.
- Guarantees: enterprise defaults merge before user/project config, while managed config remains last.
- Guarantees: only `file://` plugin origins survive final enterprise enforcement, and config loading does not start background package installation.

- [ ] **Step 1: Add failing precedence and provider-policy tests**

Append tests to `packages/opencode/test/config/config.test.ts` using the existing `withProcessEnvs`, `withGlobalConfigDir`, `withInstanceDir`, and `writeConfigEffect` helpers:

```ts
it.effect("loads enterprise defaults below global, project, and managed settings", () =>
  Effect.gen(function* () {
    const enterprise = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const root = yield* tmpdirScoped()
    const project = path.join(root, "project")
    yield* writeConfigEffect(enterprise, schemaConfig({ model: "company/default" }), "enterprise.jsonc")
    yield* writeConfigEffect(global, schemaConfig({ model: "company/global" }))
    yield* writeConfigEffect(project, schemaConfig({ model: "company/project" }))
    yield* writeManagedSettingsEffect({ model: "company/managed" })

    yield* withProcessEnvs(
      {
        OPENCODE_ENTERPRISE_OFFLINE: "1",
        OPENCODE_ENTERPRISE_DEFAULTS_PATH: path.join(enterprise, "enterprise.jsonc"),
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
        OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
        OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      },
      withGlobalConfigDir(
        global,
        withInstanceDir(
          project,
          Effect.gen(function* () {
            expect((yield* Config.use.get()).model).toBe("company/managed")
          }),
        ),
      ),
    )
  }),
)

it.effect("allows project provider overrides only on packaged internal origins", () =>
  withConfigTree(
    {
      global: {
        provider: {
          company: {
            npm: "@ai-sdk/openai-compatible",
            name: "Company",
            options: { baseURL: "https://llm.corp.example/v1" },
            models: { default: { name: "Default" } },
          },
        },
      },
      project: {
        provider: {
          company: {
            options: {
              baseURL: "https://llm-dr.corp.example/v1",
              apiKey: "plaintext-project-key",
              headers: { Authorization: "plaintext-project-header" },
            },
            models: { project: { name: "Project Model" } },
          },
          public_api: {
            npm: "@ai-sdk/openai-compatible",
            name: "Public",
            options: { baseURL: "https://api.openai.com/v1" },
            models: { default: { name: "Default" } },
          },
          embedded_secret: {
            npm: "@ai-sdk/openai-compatible",
            name: "Embedded Secret",
            options: { baseURL: "https://user:secret@llm.corp.example/v1" },
            models: { default: { name: "Default" } },
          },
        },
      },
    },
    withProcessEnvs(
      {
        OPENCODE_ENTERPRISE_OFFLINE: "1",
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example,https://llm-dr.corp.example",
      },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(Object.keys(config.provider ?? {})).toEqual(["company"])
        expect(config.provider?.company?.options?.baseURL).toBe("https://llm-dr.corp.example/v1")
        expect(config.provider?.company?.options?.apiKey).toBeUndefined()
        expect(config.provider?.company?.options?.headers).toBeUndefined()
        expect(config.provider?.company?.models?.project?.name).toBe("Project Model")
        expect(config.enabled_providers).toEqual(["company"])
      }),
    ),
  ),
)
```

In the precedence test, read the enterprise defaults file after `Config.use.get()` and assert its contents are unchanged and do not gain an injected `$schema`. This verifies the packaged resource is treated as read-only input.

Create `packages/opencode/test/config/enterprise.test.ts`:

```ts
import { expect, test } from "bun:test"
import { ConfigEnterprise } from "@/config/enterprise"

test("enterprise enforcement keeps local plugins and removes registry plugins", () => {
  const local = { spec: "file:///C:/project/.opencode/plugins/company.ts", source: "project", scope: "local" as const }
  const registry = { spec: "public-plugin@latest", source: "project", scope: "local" as const }
  const result = ConfigEnterprise.enforce(
    {
      plugin: [local.spec, registry.spec],
      plugin_origins: [local, registry],
    },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set(["https://llm.corp.example"]),
    },
  )
  expect(result.plugin).toEqual([local.spec])
  expect(result.plugin_origins).toEqual([local])
})

test("materializes company provider metadata as structured defaults", () => {
  const result = ConfigEnterprise.materializeDefaults(
    { provider: { "company-llm": { models: {} } } },
    {
      enabled: true,
      defaultsPath: "C:/app/enterprise/opencode.jsonc",
      allowedOrigins: new Set(["https://llm.corp.example"]),
      baseURL: "https://llm.corp.example/v1",
      modelID: "company-code",
      modelName: "Company Code",
    },
  )
  expect(result.model).toBe("company-llm/company-code")
  expect(result.provider?.["company-llm"]?.options?.baseURL).toBe("https://llm.corp.example/v1")
  expect(result.provider?.["company-llm"]?.models?.["company-code"]?.name).toBe("Company Code")
})
```

- [ ] **Step 2: Run the focused config tests and verify failure**

Run from `packages/opencode`:

```bash
bun test test/config/enterprise.test.ts test/config/config.test.ts --filter "enterprise defaults|packaged internal origins|enterprise enforcement|structured defaults"
```

Expected: FAIL because the enterprise config layer and enforcement do not exist.

- [ ] **Step 3: Add the enterprise config module**

```ts
// packages/opencode/src/config/enterprise.ts
export * as ConfigEnterprise from "./enterprise"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { mapValues, omit } from "remeda"
import { ConfigPlugin } from "./plugin"

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

export type Policy = ReturnType<typeof settings>
export type EnforcementPolicy = Pick<Policy, "enabled" | "defaultsPath" | "allowedOrigins">
export type DefaultsPolicy = Pick<
  Policy,
  "enabled" | "defaultsPath" | "allowedOrigins" | "baseURL" | "modelID" | "modelName"
> & { guidePath?: string }
type Info = ConfigV1.Info & { plugin_origins?: ConfigPlugin.Origin[] }

export function settings() {
  const enabled = process.env.OPENCODE_ENTERPRISE_OFFLINE === "1"
  return {
    enabled,
    defaultsPath: enabled ? process.env.OPENCODE_ENTERPRISE_DEFAULTS_PATH : undefined,
    baseURL: enabled ? process.env.OPENCODE_ENTERPRISE_BASE_URL : undefined,
    modelID: enabled ? process.env.OPENCODE_ENTERPRISE_MODEL_ID : undefined,
    modelName: enabled ? process.env.OPENCODE_ENTERPRISE_MODEL_NAME : undefined,
    allowedOrigins: new Set(
      (enabled ? process.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS : undefined)
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => new URL(item).origin) ?? [],
    ),
  }
}

export function materializeDefaults(info: Info, policy: DefaultsPolicy = settings()): Info {
  if (!policy.enabled) return info
  if (!policy.baseURL || !policy.modelID || !policy.modelName) {
    throw new Error("Enterprise provider metadata is incomplete")
  }
  const current = info.provider?.["company-llm"]
  return {
    ...info,
    model: info.model ?? `company-llm/${policy.modelID}`,
    provider: {
      ...info.provider,
      "company-llm": {
        ...current,
        npm: OPENAI_COMPATIBLE,
        name: current?.name ?? "Company LLM",
        options: { ...current?.options, baseURL: policy.baseURL },
        models: {
          ...current?.models,
          [policy.modelID]: {
            name: policy.modelName,
            ...current?.models?.[policy.modelID],
          },
        },
      },
    },
  }
}

export function enforce(info: Info, policy: EnforcementPolicy = settings()): Info {
  if (!policy.enabled) return info

  const provider = Object.fromEntries(
    Object.entries(info.provider ?? {}).flatMap((entry) => {
      if (entry[1].npm !== OPENAI_COMPATIBLE) return []
      if (typeof entry[1].options?.baseURL !== "string") return []
      try {
        const url = new URL(entry[1].options.baseURL)
        if (url.protocol !== "http:" && url.protocol !== "https:") return []
        if (url.username || url.password || !policy.allowedOrigins.has(url.origin)) return []
        return [[
          entry[0],
          {
            ...entry[1],
            options: omit(entry[1].options, ["apiKey", "headers"]),
            models: mapValues(entry[1].models ?? {}, (model) => ({
              ...omit(model, ["headers"]),
              options: omit(model.options ?? {}, ["apiKey", "headers"]),
            })),
          },
        ]] as const
      } catch {
        return []
      }
    }),
  )
  const plugin_origins = (info.plugin_origins ?? []).filter((item) =>
    ConfigPlugin.pluginSpecifier(item.spec).startsWith("file://"),
  )
  return {
    ...info,
    provider,
    enabled_providers: Object.keys(provider),
    plugin: plugin_origins.map((item) => item.spec),
    plugin_origins,
    share: "disabled",
    autoupdate: false,
  }
}
```

The copied provider entries remove provider option `apiKey`/`headers`, every model's top-level `headers`, and model option `apiKey`/`headers`. This makes the DPAPI bridge introduced by the next plan the only runtime credential source even when a project file contains plaintext credential fields.

In `loadInstanceState` in `config.ts`, merge the defaults immediately after defining `merge` and before processing well-known auth. Extend `loadFile` with an optional `{ persistSchema?: boolean }` argument that defaults to true, and skip automatic `$schema` insertion and write-back when it is false.

Import `ConfigEnterprise` from `./enterprise` alongside the other config modules, then add:

```ts
const enterprise = ConfigEnterprise.settings()
if (enterprise.defaultsPath) {
  const defaults = yield* loadFile(enterprise.defaultsPath, authEnv, { persistSchema: false })
  yield* merge(enterprise.defaultsPath, ConfigEnterprise.materializeDefaults(defaults, enterprise), "global")
}
```

This keeps the packaged resource immutable and avoids raw environment-token substitution for URLs, model IDs, model names, and later Windows guide paths.

Skip the well-known and active-account remote configuration blocks when `enterprise.enabled` is true. After managed JSON/JSONC and managed preferences have merged, apply:

```ts
result = ConfigEnterprise.enforce(result)
```

In the config-directory loop, wrap `npmSvc.install(...)`, its detached fiber, and `deps.push(dep)` in `if (!enterprise.enabled)`. Keep local command, agent, skill, and plugin file discovery outside that condition. This prevents an enterprise startup from contacting a package registry while retaining already-packaged or project-local extensions.

Create `packages/desktop/resources/enterprise/opencode.jsonc`:

```jsonc
{
  "enabled_providers": ["company-llm"],
  "provider": {
    "company-llm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Company LLM",
      "models": {}
    }
  }
}
```

- [ ] **Step 4: Run config tests and package typechecks**

Run from `packages/opencode`:

```bash
bun test test/config/enterprise.test.ts test/config/config.test.ts --filter "enterprise defaults|packaged internal origins|enterprise enforcement|structured defaults"
bun typecheck
```

Run from `packages/desktop`:

```bash
bun typecheck
```

Expected: focused tests PASS and both typechecks exit 0.

- [ ] **Step 5: Commit the default layer**

```bash
git add packages/opencode/src/config/enterprise.ts packages/opencode/src/config/config.ts packages/opencode/test/config/enterprise.test.ts packages/opencode/test/config/config.test.ts packages/desktop/resources/enterprise/opencode.jsonc
git commit -m "feat(opencode): add enterprise defaults layer"
```

### Task 3: Make the embedded model catalog deterministic and offline

**Files:**
- Create: `packages/desktop/resources/enterprise/models.json`
- Create: `packages/desktop/scripts/enterprise-model-catalog.ts`
- Create: `packages/desktop/scripts/enterprise-model-catalog.test.ts`
- Modify: `packages/desktop/scripts/prebuild.ts`
- Modify: `packages/desktop/scripts/predev.ts`

**Interfaces:**
- Produces: `enterpriseModelEnvironment(env, catalogPath)` for the nested OpenCode node build.
- Guarantees: enterprise builds set `MODELS_DEV_API_JSON` to the packaged local catalog even when the caller supplied a public catalog path.
- Guarantees: ordinary builds retain the existing model snapshot behavior.

- [ ] **Step 1: Write the failing build-environment test**

```ts
// packages/desktop/scripts/enterprise-model-catalog.test.ts
import { expect, test } from "bun:test"
import { enterpriseModelEnvironment } from "./enterprise-model-catalog"

test("enterprise builds force the packaged model catalog", () => {
  expect(
    enterpriseModelEnvironment(
      { OPENCODE_ENTERPRISE: "1", MODELS_DEV_API_JSON: "C:/tmp/public-models.json" },
      "C:/repo/packages/desktop/resources/enterprise/models.json",
    ),
  ).toMatchObject({
    OPENCODE_ENTERPRISE: "1",
    MODELS_DEV_API_JSON: "C:/repo/packages/desktop/resources/enterprise/models.json",
  })
})

test("ordinary builds preserve the caller environment", () => {
  const env = { MODELS_DEV_API_JSON: "C:/tmp/models.json" }
  expect(enterpriseModelEnvironment(env, "C:/enterprise/models.json")).toEqual(env)
})
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run from `packages/desktop`:

```bash
bun test scripts/enterprise-model-catalog.test.ts
```

Expected: FAIL because `enterprise-model-catalog.ts` does not exist.

- [ ] **Step 3: Add the local catalog and structured build helper**

Create `resources/enterprise/models.json` with an empty JSON object. The company provider and model remain in `opencode.jsonc`; this file is the deterministic embedded catalog input that prevents `script/generate.ts` from falling back to `https://models.dev/api.json`.

```json
{}
```

Create the pure environment helper:

```ts
// packages/desktop/scripts/enterprise-model-catalog.ts
type Env = Record<string, string | undefined>

export function enterpriseModelEnvironment(env: Env, catalogPath: string): Env {
  if (env.OPENCODE_ENTERPRISE !== "1") return env
  return { ...env, MODELS_DEV_API_JSON: catalogPath }
}
```

In both `prebuild.ts` and `predev.ts`, replace the nested shell `cd` build with `Bun.spawn(["bun", "script/build-node.ts"], options)`. Set:

```ts
const child = Bun.spawn(["bun", "script/build-node.ts"], {
  cwd: fileURLToPath(new URL("../../opencode/", import.meta.url)),
  env: enterpriseModelEnvironment(
    process.env,
    fileURLToPath(new URL("../resources/enterprise/models.json", import.meta.url)),
  ),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
if ((await child.exited) !== 0) throw new Error("OpenCode node build failed")
```

Import `fileURLToPath` and `enterpriseModelEnvironment` in both scripts. Keep icon and metainfo generation unchanged.

- [ ] **Step 4: Verify the helper and enterprise desktop build**

Run from `packages/desktop`:

```bash
bun test scripts/enterprise-model-catalog.test.ts
OPENCODE_ENTERPRISE=1 OPENCODE_ENTERPRISE_BASE_URL=https://llm.corp.example/v1 OPENCODE_ENTERPRISE_MODEL_ID=company-code OPENCODE_ENTERPRISE_MODEL_NAME="Company Code" OPENCODE_ENTERPRISE_ALLOWED_ORIGINS=https://llm.corp.example bun run build
```

Expected: the test passes, the build exits 0, and output contains `Loaded models.dev snapshot` without an HTTP failure because it read the packaged JSON file.

- [ ] **Step 5: Commit the offline build input**

```bash
git add packages/desktop/resources/enterprise/models.json packages/desktop/scripts/enterprise-model-catalog.ts packages/desktop/scripts/enterprise-model-catalog.test.ts packages/desktop/scripts/prebuild.ts packages/desktop/scripts/predev.ts
git commit -m "feat(desktop): embed offline model catalog"
```

### Task 4: Disable public updater, WSL, and telemetry paths

**Files:**
- Modify: `packages/desktop/src/main/constants.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/wsl/ipc.ts`
- Modify: `packages/desktop/src/renderer/index.tsx`
- Modify: `packages/desktop/electron.vite.config.ts`
- Modify: `packages/desktop/src/enterprise.ts`
- Modify: `packages/desktop/src/main/index.test.ts`
- Modify: `packages/desktop/src/main/wsl/servers.test.ts`
- Modify: `packages/opencode/src/effect/runtime-flags.ts`
- Modify: `packages/opencode/src/server/shared/ui.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`
- Modify: `packages/opencode/test/server/httpapi-ui.test.ts`
- Modify: `packages/opencode/test/config/enterprise.test.ts`

**Interfaces:**
- Consumes: `ENTERPRISE_ENABLED` from Task 1.
- Produces: `registerWslIpcHandlers(controller, enabled)` where disabled mode exposes state but rejects all WSL network/install actions.
- Produces: `enterpriseTelemetryEnabled(profile, dsn)` so runtime error reporting and build-time source-map upload are disabled together.
- Produces: `RuntimeFlags.Info.enterpriseOffline` and blocks the sidecar's public web-UI proxy and upgrade endpoint.

- [ ] **Step 1: Add failing updater and WSL policy tests**

Extract pure helpers so Electron globals are not mocked:

```ts
// packages/desktop/src/main/index.test.ts
import { expect, test } from "bun:test"
import { desktopRuntimeFeatures } from "./constants"

test("enterprise profile disables updater and WSL", () => {
  expect(desktopRuntimeFeatures({ packaged: true, channel: "prod", enterprise: true })).toEqual({
    updater: false,
    wsl: false,
  })
})

test("ordinary production keeps updater and WSL", () => {
  expect(desktopRuntimeFeatures({ packaged: true, channel: "prod", enterprise: false })).toEqual({
    updater: true,
    wsl: true,
  })
})

test("enterprise profile disables telemetry even when a DSN is present", () => {
  expect(enterpriseTelemetryEnabled({ enabled: true }, "https://sentry.example/1")).toBe(false)
  expect(enterpriseTelemetryEnabled({ enabled: false }, "https://sentry.example/1")).toBe(true)
})
```

Add `enterpriseTelemetryEnabled` to the existing import from `../enterprise` in `src/main/index.test.ts`.

Add to `packages/opencode/test/config/enterprise.test.ts`:

```ts
test("enterprise policy disables server upgrades", () => {
  expect(ConfigEnterprise.upgradeAllowed({ enabled: true })).toBe(false)
})
```

Add an `httpapi-ui.test.ts` case that passes `enterpriseOffline: true` to `serveUIEffect`, supplies an HTTP client that fails the test if executed, and asserts the response status is `404` even when `disableEmbeddedWebUi` is true.

- [ ] **Step 2: Run the test and verify the missing helper failure**

Run from `packages/desktop`:

```bash
bun test src/main/index.test.ts
```

Run from `packages/opencode`:

```bash
bun test test/config/enterprise.test.ts test/server/httpapi-ui.test.ts --filter "server upgrades|enterprise offline"
```

Expected: FAIL because the desktop helpers, enterprise runtime flag, upgrade policy, and offline UI response are not implemented.

- [ ] **Step 3: Implement runtime feature selection and gate WSL initialization**

```ts
// packages/desktop/src/main/constants.ts
export function desktopRuntimeFeatures(input: {
  packaged: boolean
  channel: Channel
  enterprise: boolean
}) {
  return {
    updater: input.packaged && input.channel !== "dev" && !input.enterprise,
    wsl: !input.enterprise,
  }
}

export const RUNTIME_FEATURES = desktopRuntimeFeatures({
  packaged: app.isPackaged,
  channel: CHANNEL,
  enterprise: ENTERPRISE_ENABLED,
})
export const UPDATER_ENABLED = RUNTIME_FEATURES.updater
```

Change `registerWslIpcHandlers` to accept an `enabled = true` parameter and route disabled mode through the existing unavailable handlers. Change the unavailable message to `WSL integration is disabled in this build` when disabled by policy.

In `src/main/index.ts`:

```ts
registerWslIpcHandlers(wslServers, RUNTIME_FEATURES.wsl)
```

and:

```ts
if (process.platform === "win32" && RUNTIME_FEATURES.wsl) {
  void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
}
```

Keep the disabled updater controller for IPC state reporting, but wrap `updater.start()`, the ten-minute update interval, and its quit cleanup in `if (RUNTIME_FEATURES.updater)`. Enterprise startup must never schedule an update check.

In `src/renderer/index.tsx`, expose WSL to the app only when enabled:

```ts
const wslServersApi = os === "windows" && !ENTERPRISE_ENABLED ? window.api.wslServers : undefined
```

Export this pure helper from `src/enterprise.ts` and use it around renderer Sentry initialization:

```ts
export function enterpriseTelemetryEnabled(profile: { enabled: boolean }, dsn?: string) {
  return !profile.enabled && Boolean(dsn)
}
```

In `electron.vite.config.ts`, require `process.env.OPENCODE_ENTERPRISE !== "1"` in the `sentry` plugin condition and set renderer `build.sourcemap` to false for enterprise builds. This prevents source-map upload when the build host has inherited Sentry credentials and prevents unused renderer maps from entering the pilot package.

Add `enterpriseOffline: bool("OPENCODE_ENTERPRISE_OFFLINE")` to `RuntimeFlags.Service`. Extend `serveUIEffect` with an optional `enterpriseOffline` service field that defaults to false; return a local `404` before loading embedded assets or invoking the upstream HTTP client when it is true. Pass `flags.enterpriseOffline` from the server UI route. This closes the existing fallback from `OPENCODE_DISABLE_EMBEDDED_WEB_UI` to `https://app.opencode.ai` without changing ordinary callers.

Export `ConfigEnterprise.upgradeAllowed(policy: Pick<Policy, "enabled"> = settings())` as `!policy.enabled`. At the start of the typed global `upgrade` handler, return `{ status: 403, body: { success: false, error: "Upgrade is disabled in this build" } }` when it is false. The existing raw handler delegates to the typed handler, so both API forms receive the same block without invoking `Installation.method`, `Installation.latest`, or `Installation.upgrade`.

- [ ] **Step 4: Verify desktop tests and typecheck**

Run from `packages/desktop`:

```bash
bun test src/main/index.test.ts src/main/wsl/servers.test.ts src/main/updater-controller.test.ts
bun typecheck
```

Expected: all selected tests PASS and typecheck exits 0.

Run from `packages/opencode`:

```bash
bun test test/config/enterprise.test.ts test/server/httpapi-ui.test.ts --filter "server upgrades|enterprise offline"
bun typecheck
```

Expected: both selected tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit offline desktop gates**

```bash
git add packages/desktop/src/main/constants.ts packages/desktop/src/main/index.ts packages/desktop/src/main/wsl/ipc.ts packages/desktop/src/renderer/index.tsx packages/desktop/electron.vite.config.ts packages/desktop/src/enterprise.ts packages/desktop/src/main/index.test.ts packages/desktop/src/main/wsl/servers.test.ts packages/opencode/src/effect/runtime-flags.ts packages/opencode/src/server/shared/ui.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts packages/opencode/test/server/httpapi-ui.test.ts packages/opencode/test/config/enterprise.test.ts
git commit -m "feat(desktop): disable public runtime paths"
```

### Task 5: Verify the foundation as one deliverable

**Files:**
- Verify only; no source changes expected.

**Interfaces:**
- Confirms all interfaces produced by Tasks 1-4 work together.

- [ ] **Step 1: Run all changed-package tests**

Run from `packages/opencode`:

```bash
bun test test/config/enterprise.test.ts test/config/config.test.ts test/server/httpapi-ui.test.ts
```

Run from `packages/desktop`:

```bash
bun test src/enterprise.test.ts src/main/index.test.ts src/main/wsl/servers.test.ts src/main/updater-controller.test.ts scripts/enterprise-model-catalog.test.ts electron-builder.config.test.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run changed-package typechecks**

Run from `packages/opencode`, then `packages/desktop`:

```bash
bun typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Build the enterprise desktop bundle with deterministic pilot inputs**

Run from `packages/desktop`:

```bash
OPENCODE_ENTERPRISE=1 OPENCODE_ENTERPRISE_BASE_URL=https://llm.corp.example/v1 OPENCODE_ENTERPRISE_MODEL_ID=company-code OPENCODE_ENTERPRISE_MODEL_NAME="Company Code" OPENCODE_ENTERPRISE_ALLOWED_ORIGINS=https://llm.corp.example bun run build
```

Expected: electron-vite build exits 0 and `out/main/index.js`, `out/main/sidecar.js`, and `out/renderer/index.html` exist.

- [ ] **Step 4: Audit foundation network gates**

```bash
rg -n "models\.dev|Sentry\.init|npmSvc\.install|loadExternal|well-known/opencode|UI_UPSTREAM|Installation\.latest|Installation\.upgrade" packages/desktop/src packages/desktop/scripts packages/opencode/src/config packages/opencode/src/plugin packages/opencode/src/server
```

Expected: every listed runtime/build path is either skipped by `enterprise.enabled`, filtered to a `file://` plugin, guarded by `enterpriseTelemetryEnabled`, or receives the packaged `MODELS_DEV_API_JSON` path.

- [ ] **Step 5: Record the foundation checkpoint**

```bash
git status --short
git log -3 --oneline
```

Expected: no uncommitted source changes and the four task commits are visible.
