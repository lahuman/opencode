import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
import { parse } from "jsonc-parser"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const originalEnterpriseOffline = process.env.OPENCODE_ENTERPRISE_OFFLINE

const legacyEnterpriseConfig = () => ({
  formatter: false,
  lsp: false,
  username: "legacy-user",
  provider: {
    "company-llm": {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://llm.corp.example/v1",
        timeout: 1_000,
        providerSetting: "kept-provider-setting",
        key: "legacy-provider-key-secret",
        apiKey: "legacy-provider-api-key-secret",
        headers: {
          Authorization: "legacy-provider-authorization-secret",
          "X-Provider-Secret": "legacy-provider-header-secret",
        },
      },
      models: {
        "company-code": {
          name: "Company Code",
          headers: { Authorization: "legacy-model-authorization-secret" },
          options: {
            temperature: 0,
            modelSetting: "kept-model-setting",
            key: "legacy-model-key-secret",
            apiKey: "legacy-model-api-key-secret",
            headers: { "X-Model-Secret": "legacy-model-header-secret" },
          },
        },
      },
    },
  },
})

const secretFreePatch = () => ({
  username: "patched-user",
  provider: {
    "company-llm": {
      options: { timeout: 2_345 },
      models: { "company-code": { name: "Patched Company Code", options: { temperature: 0.25 } } },
    },
  },
})

const replacementSecretPatch = () => ({
  provider: {
    "company-llm": {
      options: {
        timeout: 3_456,
        key: "replacement-provider-key-secret",
        apiKey: "replacement-provider-api-key-secret",
        headers: { Authorization: "replacement-provider-header-secret" },
      },
      models: {
        "company-code": {
          headers: { Authorization: "replacement-model-header-secret" },
          options: {
            temperature: 0.5,
            key: "replacement-model-key-secret",
            apiKey: "replacement-model-api-key-secret",
            headers: { Authorization: "replacement-model-option-header-secret" },
          },
        },
      },
    },
  },
})

const expectSanitizedEnterpriseConfig = (config: unknown, timeout: number, temperature: number) => {
  expect(config).toMatchObject({
    formatter: false,
    lsp: false,
    username: "patched-user",
    provider: {
      "company-llm": {
        options: {
          baseURL: "https://llm.corp.example/v1",
          timeout,
          providerSetting: "kept-provider-setting",
        },
        models: {
          "company-code": {
            name: "Patched Company Code",
            options: { temperature, modelSetting: "kept-model-setting" },
          },
        },
      },
    },
  })
  const serialized = JSON.stringify(config)
  expect(serialized).not.toContain("legacy-")
  expect(serialized).not.toContain("replacement-")
  expect(serialized).not.toContain('"key"')
  expect(serialized).not.toContain("apiKey")
  expect(serialized).not.toContain("headers")
}

const patchProject = (directory: string, patch: object) =>
  Effect.gen(function* () {
    const disposed = yield* waitDisposed(directory).pipe(Effect.forkScoped({ startImmediately: true }))
    const response = yield* Effect.promise(() =>
      Promise.resolve(
        app().request("/config", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-opencode-directory": directory,
          },
          body: JSON.stringify(patch),
        }),
      ),
    )
    expect(response.status).toBe(200)
    yield* Fiber.join(disposed)
    return yield* Effect.promise(() => response.json())
  })

const patchGlobal = (patch: object) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      Promise.resolve(
        app().request("/global/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ),
    )
    expect(response.status).toBe(200)
    return yield* Effect.promise(() => response.json())
  })

const readConfig = (file: string) =>
  Effect.promise(() =>
    Bun.file(file)
      .text()
      .then((text) => parse(text)),
  )

const globalPersistenceTest = (filename: "opencode.json" | "opencode.jsonc") =>
  Effect.gen(function* () {
    process.env.OPENCODE_ENTERPRISE_OFFLINE = "1"
    const tmp = yield* tmpdirEffect({})
    const file = path.join(tmp.path, filename)
    const initial = JSON.stringify(legacyEnterpriseConfig(), null, 2)
    yield* Effect.promise(() =>
      Bun.write(file, filename.endsWith(".jsonc") ? `// keep-comment\n${initial}\n` : initial),
    )
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = tmp.path
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const firstResponse = yield* patchGlobal(secretFreePatch())
          expectSanitizedEnterpriseConfig(yield* readConfig(file), 2_345, 0.25)
          expectSanitizedEnterpriseConfig(firstResponse, 2_345, 0.25)

          const secondResponse = yield* patchGlobal(replacementSecretPatch())
          expectSanitizedEnterpriseConfig(yield* readConfig(file), 3_456, 0.5)
          expectSanitizedEnterpriseConfig(secondResponse, 3_456, 0.5)
          if (filename.endsWith(".jsonc")) {
            expect(yield* Effect.promise(() => Bun.file(file).text())).toContain("// keep-comment")
          }
        }),
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
        }),
    )
  })

afterEach(async () => {
  if (originalEnterpriseOffline === undefined) delete process.env.OPENCODE_ENTERPRISE_OFFLINE
  else process.env.OPENCODE_ENTERPRISE_OFFLINE = originalEnterpriseOffline
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "removes stale and replacement secrets from merged enterprise project config",
    Effect.gen(function* () {
      process.env.OPENCODE_ENTERPRISE_OFFLINE = "1"
      const tmp = yield* tmpdirEffect({})
      const file = path.join(tmp.path, "config.json")
      yield* Effect.promise(() => Bun.write(file, JSON.stringify(legacyEnterpriseConfig(), null, 2)))

      const firstResponse = yield* patchProject(tmp.path, secretFreePatch())
      expectSanitizedEnterpriseConfig(yield* readConfig(file), 2_345, 0.25)
      expectSanitizedEnterpriseConfig(firstResponse, 2_345, 0.25)

      const secondResponse = yield* patchProject(tmp.path, replacementSecretPatch())
      expectSanitizedEnterpriseConfig(yield* readConfig(file), 3_456, 0.5)
      expectSanitizedEnterpriseConfig(secondResponse, 3_456, 0.5)
    }),
  )

  it.live(
    "removes stale and replacement secrets from merged enterprise global JSON config",
    globalPersistenceTest("opencode.json"),
  )

  it.live(
    "removes stale and replacement secrets from merged enterprise global JSONC config",
    globalPersistenceTest("opencode.jsonc"),
  )

  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
