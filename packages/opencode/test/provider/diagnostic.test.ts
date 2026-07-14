import { afterEach, describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { MockLanguageModelV3 } from "ai/test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import path from "path"
import { ProviderDiagnostic } from "@/provider/diagnostic"
import { ProviderEnterprise } from "@/provider/enterprise"
import { ProviderError } from "@/provider/error"
import { Provider } from "@/provider/provider"
import { ProviderApi } from "@/server/routes/instance/httpapi/groups/provider"
import { ProviderTest } from "../fake/provider"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "../server/httpapi-layer"

type Mode =
  | "pass"
  | "auth"
  | "model"
  | "timeout-message"
  | "timeout-408"
  | "timeout-504"
  | "stream"
  | "partial-stream"
  | "stream-auth"
  | "policy-stream"
  | "policy-tool"
  | "wrong-tool"
  | "invalid-tool"
  | "tool"
type RequestBody = { stream?: boolean; tools?: unknown }

const endpointRequests: Headers[] = []

afterEach(async () => {
  endpointRequests.length = 0
  ProviderEnterprise.setCredentials({ headers: {} })
  await disposeAllInstances()
})

describe("provider diagnostics", () => {
  test("accepts only precise input and result schema values", () => {
    expect(
      Schema.decodeUnknownSync(ProviderDiagnostic.Input)({ modelID: "company-code", checkToolCall: true }),
    ).toEqual({ modelID: ModelV2.ID.make("company-code"), checkToolCall: true })
    expect(() => Schema.decodeUnknownSync(ProviderDiagnostic.Input)({ modelID: "company-code" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ProviderDiagnostic.Input)({ modelID: "company-code", checkToolCall: "true" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ProviderDiagnostic.Result)({
        ok: false,
        checks: { basic: "broken", streaming: "skipped", toolCall: "skipped" },
        failure: { kind: "response", message: "safe" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ProviderDiagnostic.Result)({
        ok: false,
        checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
        failure: { kind: "raw_exception", message: "unsafe" },
      }),
    ).toThrow()
  })

  test("classifies transport, HTTP, and compatibility failures", () => {
    expect(ProviderDiagnostic.classify({ statusCode: 401 })).toBe("auth")
    expect(ProviderDiagnostic.classify({ statusCode: 403 })).toBe("auth")
    expect(ProviderDiagnostic.classify({ statusCode: 404, modelCode: "model_not_found" })).toBe("model")
    expect(ProviderDiagnostic.classify({ codes: ["ENOTFOUND"] })).toBe("dns")
    expect(ProviderDiagnostic.classify({ codes: ["CERT_AUTHORITY_INVALID"] })).toBe("tls")
    expect(ProviderDiagnostic.classify({ codes: ["ETIMEDOUT"] })).toBe("timeout")
    expect(ProviderDiagnostic.classify({ codes: ["ECONNREFUSED"] })).toBe("connection")
    expect(ProviderDiagnostic.classify({})).toBe("response")
    expect(ProviderDiagnostic.classify({ stage: "streaming" })).toBe("stream")
    expect(ProviderDiagnostic.classify({ stage: "toolCall" })).toBe("tool_call")
  })

  test("classifies exact structured transport codes", () => {
    for (const code of [
      "FailedToOpenSocket",
      "ConnectionRefused",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
    ]) {
      expect(ProviderDiagnostic.classify({ codes: [code] }), code).toBe("connection")
    }
    for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
      expect(ProviderDiagnostic.classify({ codes: [code] }), code).toBe("dns")
    }
    for (const code of [
      "CERT_AUTHORITY_INVALID",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ]) {
      expect(ProviderDiagnostic.classify({ codes: [code] }), code).toBe("tls")
    }
    for (const code of ["ETIMEDOUT", "ABORT_ERR", "AbortError", "TimeoutError", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(ProviderDiagnostic.classify({ codes: [code] }), code).toBe("timeout")
    }
    expect(ProviderDiagnostic.classify({ statusCode: 401, codes: ["ENOTFOUND"] })).toBe("auth")
    expect(
      ProviderDiagnostic.classify({
        statusCode: 404,
        modelCode: "model_not_found",
        codes: ["ENOTFOUND"],
      }),
    ).toBe("model")
  })

  test("classifies trusted Bun connection-close and provider header-timeout causes", async () => {
    const connectionByName = new Error("CONNECTION_NAME_SECRET")
    connectionByName.name = "ConnectionClosed"
    const connectionByCode = Object.assign(new Error("CONNECTION_CODE_SECRET"), { code: "ConnectionClosed" })

    for (const error of [connectionByName, connectionByCode]) {
      const result = await ProviderDiagnostic.probe(
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw error
          },
        }),
        false,
      )

      expect(result).toEqual({
        ok: false,
        checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
        failure: {
          kind: "connection",
          message: "Cannot reach the Company LLM endpoint. Check the service and network route.",
        },
      })
      expect(JSON.stringify(result)).not.toContain(error.message)
    }

    const headerTimeout = new ProviderError.HeaderTimeoutError(50)
    const result = await ProviderDiagnostic.probe(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw headerTimeout
        },
      }),
      false,
    )

    expect(result).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: {
        kind: "timeout",
        message: "The Company LLM request timed out. Check service load and network latency.",
      },
    })
    expect(JSON.stringify(result)).not.toContain(headerTimeout.message)
  })

  test("classifies only the trusted response stream timeout error as timeout", async () => {
    const model = (error: Error) =>
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text", text: "OK" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }),
        doStream: async () => {
          throw error
        },
      })
    const timeout = await ProviderDiagnostic.probe(model(new ProviderError.ResponseStreamTimeoutError(50)), false)
    const stream = await ProviderDiagnostic.probe(
      model(new ProviderError.ResponseStreamError("request timed out by provider policy")),
      false,
    )

    expect(timeout).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "fail", toolCall: "skipped" },
      failure: {
        kind: "timeout",
        message: "The Company LLM request timed out. Check service load and network latency.",
      },
    })
    expect(stream).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "fail", toolCall: "skipped" },
      failure: {
        kind: "stream",
        message: "The endpoint did not return a compatible streaming response.",
      },
    })
    expect(JSON.stringify({ timeout, stream })).not.toContain("request timed out by provider policy")
  })

  test("uses exact transport codes and timeout statuses without partial code matches", () => {
    expect(ProviderDiagnostic.classify({ stage: "streaming" })).toBe("stream")
    expect(ProviderDiagnostic.classify({})).toBe("response")
    expect(ProviderDiagnostic.classify({ statusCode: 408, stage: "streaming" })).toBe("timeout")
    expect(ProviderDiagnostic.classify({ statusCode: 504, stage: "streaming" })).toBe("timeout")

    for (const code of [
      "PROVIDER_ABORTED_BY_POLICY",
      "NOT_ETIMEDOUT",
      "ENOTFOUND_POLICY",
      "CERT_AUTHORITY_INVALID_POLICY",
      "ECONNREFUSED_BY_POLICY",
    ]) {
      expect(ProviderDiagnostic.classify({ codes: [code], stage: "streaming" }), code).toBe("stream")
    }
    expect(ProviderDiagnostic.classify({ codes: [" econnrefused "] })).toBe("connection")
    expect(ProviderDiagnostic.classify({ statusCode: 401, codes: ["ABORT_ERR"] })).toBe("auth")
    expect(ProviderDiagnostic.classify({ statusCode: 504, modelCode: "model_not_found" })).toBe("timeout")
  })

  test("requires HTTP 404 and an exact structured model error code", () => {
    for (const modelCode of ["model_not_found", "deployment_not_found", "model_does_not_exist"]) {
      expect(ProviderDiagnostic.classify({ statusCode: 404, modelCode }), modelCode).toBe("model")
    }
    expect(ProviderDiagnostic.classify({ statusCode: 401, modelCode: "model_not_found" })).toBe("auth")
    expect(ProviderDiagnostic.classify({ statusCode: 404, modelCode: "ETIMEDOUT", stage: "streaming" })).toBe("stream")
    expect(ProviderDiagnostic.classify({ statusCode: 400, modelCode: "model_not_found", stage: "toolCall" })).toBe(
      "tool_call",
    )
  })

  test("checks basic response and streaming through the real adapter", async () => {
    using server = diagnosticServer("pass")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "test" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), false)

    expect(result).toEqual({
      ok: true,
      checks: { basic: "pass", streaming: "pass", toolCall: "skipped" },
    })
  })

  test("checks optional tool calls through the real adapter", async () => {
    using server = diagnosticServer("pass")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "test" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)

    expect(result).toEqual({
      ok: true,
      checks: { basic: "pass", streaming: "pass", toolCall: "pass" },
    })
  })

  test("rejects a wrong tool name through the real adapter", async () => {
    using server = diagnosticServer("wrong-tool")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "wrong-tool-key" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)
    const serialized = JSON.stringify(Schema.encodeSync(ProviderDiagnostic.Result)(result))

    expect(result).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "pass", toolCall: "fail" },
      failure: {
        kind: "tool_call",
        message: "The configured model did not return the requested tool call.",
      },
    })
    expect(serialized).not.toContain("wrong_tool")
    expect(serialized).not.toContain("WRONG_TOOL_SECRET")
    expect(serialized).not.toContain("wrong-tool-key")
  })

  test("rejects a schema-invalid enterprise_probe call through the real adapter", async () => {
    using server = diagnosticServer("invalid-tool")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "invalid-tool-key" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)
    const serialized = JSON.stringify(Schema.encodeSync(ProviderDiagnostic.Result)(result))

    expect(result).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "pass", toolCall: "fail" },
      failure: {
        kind: "tool_call",
        message: "The configured model did not return the requested tool call.",
      },
    })
    expect(serialized).not.toContain("INVALID_TOOL_SECRET")
    expect(serialized).not.toContain("invalid-tool-key")
  })

  test("classifies a real adapter request to a closed Bun port as connection failure", async () => {
    using server = diagnosticServer("pass")
    const baseURL = `${server.url}v1`
    await server.stop(true)
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL, apiKey: "closed-port-secret" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), false)
    const serialized = JSON.stringify(Schema.encodeSync(ProviderDiagnostic.Result)(result))

    expect(result).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: {
        kind: "connection",
        message: "Cannot reach the Company LLM endpoint. Check the service and network route.",
      },
    })
    expect(serialized).not.toContain(baseURL)
    expect(serialized).not.toContain("closed-port-secret")
    expect(serialized).not.toContain("FailedToOpenSocket")
    expect(serialized).not.toContain("Cannot connect to API")
  })

  test("returns only a fixed safe message and skips later checks after basic failure", async () => {
    using server = diagnosticServer("auth")
    const sdk = createOpenAICompatible({
      name: "company-llm",
      baseURL: `${server.url}v1/private-secret-url`,
      apiKey: "sk-secret-api-key",
    })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)
    const serialized = JSON.stringify(Schema.encodeSync(ProviderDiagnostic.Result)(result))

    expect(result).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: {
        kind: "auth",
        message: "Authentication failed (HTTP 401/403). Update the stored company credentials.",
      },
    })
    expect(serialized).not.toContain("sk-secret-api-key")
    expect(serialized).not.toContain("private-secret-url")
    expect(serialized).not.toContain("RAW_RESPONSE_BODY")
    expect(serialized).not.toContain("secret-header-value")
  })

  test("classifies a standard OpenAI model-not-found response through the real adapter", async () => {
    using server = diagnosticServer("model")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "model-secret" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)
    const serialized = JSON.stringify(Schema.encodeSync(ProviderDiagnostic.Result)(result))

    expect(result).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: {
        kind: "model",
        message: "The configured model is unavailable. Check the project model ID.",
      },
    })
    expect(serialized).not.toContain("MODEL_SECRET_MARKER")
    expect(serialized).not.toContain("model-secret")
  })

  test("does not trust an HTTP 400 provider timeout message", async () => {
    using server = diagnosticServer("timeout-message")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "timeout-secret" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)
    const serialized = JSON.stringify(Schema.encodeSync(ProviderDiagnostic.Result)(result))

    expect(result).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: {
        kind: "response",
        message: "The endpoint returned an incompatible OpenAI-style response.",
      },
    })
    expect(serialized).not.toContain("request timed out")
    expect(serialized).not.toContain("provider_timeout_marker")
    expect(serialized).not.toContain("timeout-secret")
  })

  test("classifies real HTTP 408 and 504 responses as timeout failures", async () => {
    using requestTimeoutServer = diagnosticServer("timeout-408")
    using gatewayTimeoutServer = diagnosticServer("timeout-504")
    const requestTimeout = createOpenAICompatible({
      name: "company-llm",
      baseURL: `${requestTimeoutServer.url}v1`,
      apiKey: "test",
    })
    const gatewayTimeout = createOpenAICompatible({
      name: "company-llm",
      baseURL: `${gatewayTimeoutServer.url}v1`,
      apiKey: "test",
    })

    for (const model of [requestTimeout("company-code"), gatewayTimeout("company-code")]) {
      expect(await ProviderDiagnostic.probe(model, true)).toEqual({
        ok: false,
        checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
        failure: {
          kind: "timeout",
          message: "The Company LLM request timed out. Check service load and network latency.",
        },
      })
    }
  })

  test("interrupts a blocked basic provider request without starting later stages", async () => {
    const started = Promise.withResolvers<void>()
    const requestAborted = Promise.withResolvers<"request">()
    const responseCanceled = Promise.withResolvers<"response">()
    const requests: RequestBody[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as RequestBody)
        request.signal.addEventListener("abort", () => requestAborted.resolve("request"), { once: true })
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              started.resolve()
            },
            cancel() {
              responseCanceled.resolve("response")
            },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "test" })
    const provider = ProviderTest.fake({
      getLanguage: Effect.fn("ProviderDiagnosticTest.getLanguage")(() => Effect.succeed(sdk("company-code"))),
    })

    const result = await Effect.gen(function* () {
      const diagnostic = yield* ProviderDiagnostic.Service
      const fiber = yield* diagnostic
        .run(provider.info.id, { modelID: provider.model.id, checkToolCall: true })
        .pipe(Effect.forkChild)
      const didStart = yield* Effect.promise(() =>
        Promise.race([started.promise.then(() => true), Bun.sleep(1_000).then(() => false)]),
      )
      expect(didStart).toBe(true)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      const closedBy = yield* Effect.promise(() =>
        Promise.race([
          requestAborted.promise,
          responseCanceled.promise,
          Bun.sleep(1_000).then(() => "timeout" as const),
        ]),
      )
      return { exit, closedBy }
    }).pipe(
      Effect.provide(LayerNode.compile(ProviderDiagnostic.node, [[Provider.node, provider.layer]])),
      Effect.scoped,
      Effect.runPromise,
    )

    expect(result.closedBy).not.toBe("timeout")
    expect(Exit.isFailure(result.exit)).toBe(true)
    if (Exit.isFailure(result.exit)) expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0].stream).not.toBe(true)
    expect(requests[0].tools).toBeUndefined()
  })

  test("returns a safe result for typed provider model resolution failures", async () => {
    const provider = ProviderTest.fake({
      getModel: Effect.fn("ProviderDiagnosticTest.getModel")((providerID, modelID) =>
        Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID })),
      ),
    })

    const result = await Effect.gen(function* () {
      const diagnostic = yield* ProviderDiagnostic.Service
      return yield* diagnostic.run(provider.info.id, { modelID: provider.model.id, checkToolCall: true })
    }).pipe(
      Effect.provide(LayerNode.compile(ProviderDiagnostic.node, [[Provider.node, provider.layer]])),
      Effect.scoped,
      Effect.runPromise,
    )

    expect(result).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: {
        kind: "model",
        message: "The configured model is unavailable. Check the project model ID.",
      },
    })
  })

  test("marks streaming failure after a passing basic check", async () => {
    using server = diagnosticServer("stream")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "test" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)

    expect(result).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "fail", toolCall: "skipped" },
      failure: {
        kind: "stream",
        message: "The endpoint did not return a compatible streaming response.",
      },
    })
  })

  test("fails streaming when an SSE error follows partial text", async () => {
    using server = diagnosticServer("partial-stream")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "test" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)

    expect(result).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "fail", toolCall: "skipped" },
      failure: {
        kind: "stream",
        message: "The endpoint did not return a compatible streaming response.",
      },
    })
  })

  test("preserves streaming HTTP auth failures without exposing raw response details", async () => {
    using server = diagnosticServer("stream-auth")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "stream-secret" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)
    const serialized = JSON.stringify(Schema.encodeSync(ProviderDiagnostic.Result)(result))

    expect(result).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "fail", toolCall: "skipped" },
      failure: {
        kind: "auth",
        message: "Authentication failed (HTTP 401/403). Update the stored company credentials.",
      },
    })
    expect(serialized).not.toContain("stream-secret")
    expect(serialized).not.toContain("STREAM_RAW_RESPONSE_BODY")
    expect(serialized).not.toContain("stream-secret-header")
  })

  test("keeps transport phrases in streaming provider policy errors at the stream stage", async () => {
    using server = diagnosticServer("policy-stream")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "test" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)

    expect(result).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "fail", toolCall: "skipped" },
      failure: {
        kind: "stream",
        message: "The endpoint did not return a compatible streaming response.",
      },
    })
  })

  test("keeps transport phrases in tool provider policy errors at the tool-call stage", async () => {
    using server = diagnosticServer("policy-tool")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "test" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)
    const serialized = JSON.stringify(Schema.encodeSync(ProviderDiagnostic.Result)(result))

    expect(result).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "pass", toolCall: "fail" },
      failure: {
        kind: "tool_call",
        message: "The configured model did not return the requested tool call.",
      },
    })
    expect(serialized).not.toContain("POLICY_SECRET_MARKER")
  })

  test("marks tool-call failure after passing basic and streaming checks", async () => {
    using server = diagnosticServer("tool")
    const sdk = createOpenAICompatible({ name: "company-llm", baseURL: `${server.url}v1`, apiKey: "test" })

    const result = await ProviderDiagnostic.probe(sdk("company-code"), true)

    expect(result).toEqual({
      ok: false,
      checks: { basic: "pass", streaming: "pass", toolCall: "fail" },
      failure: {
        kind: "tool_call",
        message: "The configured model did not return the requested tool call.",
      },
    })
  })

  test("declares the authenticated provider.diagnose HttpApi operation", () => {
    const spec = OpenApi.fromApi(ProviderApi)
    const operation = spec.paths?.["/provider/{providerID}/diagnostics"]?.post

    expect(operation?.operationId).toBe("provider.diagnose")
    expect(operation?.responses?.["200"]).toBeDefined()
    expect(operation?.responses?.["401"]).toBeDefined()
    expect(operation?.requestBody?.content?.["application/json"]).toBeDefined()
  })

  test("generated client sends provider.diagnose to the diagnostic endpoint", async () => {
    const requests: Request[] = []
    const transport: typeof fetch = Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        requests.push(request)
        return Response.json({
          ok: true,
          checks: { basic: "pass", streaming: "pass", toolCall: "skipped" },
        })
      },
      { preconnect: fetch.preconnect },
    )
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      fetch: transport,
    })

    const result = await client.provider.diagnose({
      providerID: "company-llm",
      modelID: "company-code",
      checkToolCall: false,
    })

    expect(result.data).toEqual({
      ok: true,
      checks: { basic: "pass", streaming: "pass", toolCall: "skipped" },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe("POST")
    expect(new URL(requests[0].url).pathname).toBe("/provider/company-llm/diagnostics")
    expect(await requests[0].json()).toEqual({ modelID: "company-code", checkToolCall: false })
  })
})

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)
const endpointIt = testEffect(
  Layer.mergeAll(
    testStateLayer,
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(CrossSpawnSpawner.node),
    httpApiLayer,
  ),
)

endpointIt.instance(
  "runs the diagnostic endpoint through the configured provider and enterprise credential overlay",
  Effect.gen(function* () {
    endpointRequests.length = 0
    ProviderEnterprise.setCredentials({
      apiKey: "enterprise-api-key",
      headers: { "x-company-token": "enterprise-header-value" },
    })
    const directory = (yield* TestInstance).directory
    const response = yield* request("/provider/company-llm/diagnostics", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": directory },
      body: JSON.stringify({ modelID: "company-code", checkToolCall: false }),
    })

    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({
      ok: true,
      checks: { basic: "pass", streaming: "pass", toolCall: "skipped" },
    })
    expect(endpointRequests).toHaveLength(2)
    expect(endpointRequests.every((headers) => headers.get("authorization") === "Bearer enterprise-api-key")).toBe(true)
    expect(endpointRequests.every((headers) => headers.get("x-company-token") === "enterprise-header-value")).toBe(true)
  }),
  { init: initializeEndpointProject },
  30_000,
)

function diagnosticServer(mode: Mode, headers: Headers[] = []) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      headers.push(request.headers)
      const body = (await request.json()) as RequestBody
      if (mode === "stream-auth" && body.stream) {
        return Response.json(
          { error: { message: "STREAM_RAW_RESPONSE_BODY", type: "stream-secret-header" } },
          { status: 401, headers: { "x-secret-response-header": "stream-secret-header" } },
        )
      }
      if (mode === "auth") {
        return Response.json(
          {
            error: {
              message: "RAW_RESPONSE_BODY sk-secret-api-key https://llm.corp.example/private-secret-url",
              type: "secret-header-value",
            },
          },
          { status: 401, headers: { "x-secret-response-header": "secret-header-value" } },
        )
      }
      if (mode === "model") {
        return Response.json(
          {
            error: {
              message: "MODEL_SECRET_MARKER: the requested model does not exist",
              type: "invalid_request_error",
              code: "model_not_found",
            },
          },
          { status: 404 },
        )
      }
      if (mode === "timeout-message") {
        return Response.json(
          {
            error: {
              message: "request timed out",
              type: "provider_error",
              code: "provider_timeout_marker",
            },
          },
          { status: 400 },
        )
      }
      if (mode === "timeout-408" || mode === "timeout-504") {
        return Response.json(
          { error: { message: "provider unavailable", type: "provider_error" } },
          { status: mode === "timeout-408" ? 408 : 504 },
        )
      }
      if (body.stream) {
        if (mode === "stream") {
          return new Response("data: not-json\n\ndata: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        }
        if (mode === "partial-stream") {
          return new Response(partialStreamResponse(), { headers: { "content-type": "text/event-stream" } })
        }
        if (mode === "policy-stream") {
          return new Response(
            "data: POLICY_SECRET_MARKER provider policy: request timeout; cannot connect to API\n\ndata: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        return new Response(streamResponse(), { headers: { "content-type": "text/event-stream" } })
      }
      if (body.tools && mode === "policy-tool") {
        return Response.json(
          {
            error: {
              message: "POLICY_SECRET_MARKER provider policy: request timeout; cannot connect to API",
              type: "policy_error",
              code: "policy_restricted",
            },
          },
          { status: 400 },
        )
      }
      if (body.tools && mode === "wrong-tool") {
        return Response.json(toolResponse("wrong_tool", '{"secret":"WRONG_TOOL_SECRET"}'))
      }
      if (body.tools && mode === "invalid-tool") {
        return Response.json(toolResponse("enterprise_probe", '{"unexpected":"INVALID_TOOL_SECRET"}'))
      }
      if (body.tools && mode === "pass") return Response.json(toolResponse())
      return Response.json(textResponse())
    },
  })
}

function textResponse() {
  return {
    id: "chatcmpl-basic",
    object: "chat.completion",
    created: 1,
    model: "company-code",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function toolResponse(name = "enterprise_probe", input = "{}") {
  return {
    id: "chatcmpl-tool",
    object: "chat.completion",
    created: 1,
    model: "company-code",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-enterprise-probe",
              type: "function",
              function: { name, arguments: input },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function streamResponse() {
  return [
    'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"company-code","choices":[{"index":0,"delta":{"content":"O"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"company-code","choices":[{"index":0,"delta":{"content":"K"},"finish_reason":"stop"}]}',
    "data: [DONE]",
    "",
  ].join("\n\n")
}

function partialStreamResponse() {
  return [
    'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1,"model":"company-code","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}',
    "data: not-json",
    "data: [DONE]",
    "",
  ].join("\n\n")
}

function initializeEndpointProject(directory: string) {
  return Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => diagnosticServer("pass", endpointRequests)),
      (server) => Effect.promise(() => server.stop(true)),
    )
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          formatter: false,
          lsp: false,
          provider: {
            "company-llm": {
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: `${server.url}v1`,
                apiKey: "project-api-key",
                headers: { "x-company-token": "project-header-value" },
              },
              models: { "company-code": { name: "Company Code" } },
            },
          },
        }),
      ),
    )
  })
}
