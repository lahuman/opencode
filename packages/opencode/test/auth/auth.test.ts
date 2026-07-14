import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))
const originalEnterpriseOffline = process.env.OPENCODE_ENTERPRISE_OFFLINE
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT

afterEach(() => {
  if (originalEnterpriseOffline === undefined) delete process.env.OPENCODE_ENTERPRISE_OFFLINE
  else process.env.OPENCODE_ENTERPRISE_OFFLINE = originalEnterpriseOffline
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
})

test("disables plaintext auth persistence in enterprise mode", () => {
  expect(Auth.persistenceEnabled({ OPENCODE_ENTERPRISE_OFFLINE: "1" })).toBe(false)
  expect(Auth.persistenceEnabled({})).toBe(true)
})

describe("Auth", () => {
  it.instance("neutralizes generic auth.json and rejects plaintext auth persistence writes", () =>
    Effect.gen(function* () {
      delete process.env.OPENCODE_ENTERPRISE_OFFLINE
      delete process.env.OPENCODE_AUTH_CONTENT
      const auth = yield* Auth.Service
      yield* auth.set("company-llm", { type: "api", key: "legacy-secret" })

      process.env.OPENCODE_ENTERPRISE_OFFLINE = "1"
      process.env.OPENCODE_AUTH_CONTENT = "{}"
      expect(yield* auth.all()).toEqual({})
      expect(
        (yield* auth.set("company-llm", { type: "api", key: "replacement-secret" }).pipe(Effect.flip)).message,
      ).toBe("Auth persistence is disabled in this build")
      expect((yield* auth.remove("company-llm").pipe(Effect.flip)).message).toBe(
        "Auth persistence is disabled in this build",
      )

      delete process.env.OPENCODE_ENTERPRISE_OFFLINE
      delete process.env.OPENCODE_AUTH_CONTENT
      expect(yield* auth.get("company-llm")).toEqual({ type: "api", key: "legacy-secret" })
    }),
  )

  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )
})
