import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
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

const enterprisePatch = () => ({
  formatter: false,
  lsp: false,
  provider: {
    "company-llm": {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://llm.corp.example/v1",
        timeout: 2_345,
        key: "provider-key-secret",
        apiKey: "provider-api-key-secret",
        headers: {
          Authorization: "provider-authorization-secret",
          "X-Provider-Secret": "provider-header-secret",
        },
      },
      models: {
        "company-code": {
          name: "Company Code",
          headers: { Authorization: "model-authorization-secret" },
          options: {
            temperature: 0,
            key: "model-key-secret",
            apiKey: "model-api-key-secret",
            headers: { "X-Model-Secret": "model-header-secret" },
          },
        },
      },
    },
  },
})

const expectSanitizedEnterpriseConfig = (config: unknown) => {
  expect(config).toMatchObject({
    formatter: false,
    lsp: false,
    provider: {
      "company-llm": {
        options: {
          baseURL: "https://llm.corp.example/v1",
          timeout: 2_345,
        },
        models: {
          "company-code": {
            name: "Company Code",
            options: { temperature: 0 },
          },
        },
      },
    },
  })
  const serialized = JSON.stringify(config)
  expect(serialized).not.toContain("key-secret")
  expect(serialized).not.toContain("authorization-secret")
  expect(serialized).not.toContain("header-secret")
  expect(serialized).not.toContain("apiKey")
  expect(serialized).not.toContain("headers")
}

afterEach(async () => {
  if (originalEnterpriseOffline === undefined) delete process.env.OPENCODE_ENTERPRISE_OFFLINE
  else process.env.OPENCODE_ENTERPRISE_OFFLINE = originalEnterpriseOffline
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "sanitizes enterprise project config before persistence",
    Effect.gen(function* () {
      process.env.OPENCODE_ENTERPRISE_OFFLINE = "1"
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
            body: JSON.stringify(enterprisePatch()),
          }),
        ),
      )

      expect(response.status).toBe(200)
      yield* Fiber.join(disposed)
      expectSanitizedEnterpriseConfig(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json()))
      expectSanitizedEnterpriseConfig(yield* Effect.promise(() => response.json()))
    }),
  )

  it.live(
    "sanitizes enterprise global config before persistence",
    Effect.gen(function* () {
      process.env.OPENCODE_ENTERPRISE_OFFLINE = "1"
      const tmp = yield* tmpdirEffect({})
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "opencode.json"), "{}"))
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = tmp.path
          return previous
        }),
        () =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              Promise.resolve(
                app().request("/global/config", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(enterprisePatch()),
                }),
              ),
            )

            expect(response.status).toBe(200)
            expectSanitizedEnterpriseConfig(
              yield* Effect.promise(() => Bun.file(path.join(tmp.path, "opencode.json")).json()),
            )
            expectSanitizedEnterpriseConfig(yield* Effect.promise(() => response.json()))
          }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      )
    }),
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
