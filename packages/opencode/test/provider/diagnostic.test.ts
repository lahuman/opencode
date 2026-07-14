import { afterEach, describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect, Layer, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import path from "path"
import { ProviderDiagnostic } from "@/provider/diagnostic"
import { ProviderEnterprise } from "@/provider/enterprise"
import { ProviderApi } from "@/server/routes/instance/httpapi/groups/provider"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "../server/httpapi-layer"

type Mode = "pass" | "auth" | "stream" | "partial-stream" | "stream-auth" | "tool"
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
    expect(ProviderDiagnostic.classify({ statusCode: 401, message: "Unauthorized" })).toBe("auth")
    expect(ProviderDiagnostic.classify({ statusCode: 403, message: "Forbidden" })).toBe("auth")
    expect(ProviderDiagnostic.classify({ statusCode: 404, message: "model not found" })).toBe("model")
    expect(ProviderDiagnostic.classify({ message: "fetch failed: ENOTFOUND llm.corp" })).toBe("dns")
    expect(ProviderDiagnostic.classify({ message: "CERT_AUTHORITY_INVALID" })).toBe("tls")
    expect(ProviderDiagnostic.classify({ message: "request timed out" })).toBe("timeout")
    expect(ProviderDiagnostic.classify({ message: "ECONNREFUSED" })).toBe("connection")
    expect(ProviderDiagnostic.classify({ message: "invalid JSON response" })).toBe("response")
    expect(ProviderDiagnostic.classify({ message: "invalid stream chunk", stage: "streaming" })).toBe("stream")
    expect(ProviderDiagnostic.classify({ message: "Tool call was not returned", stage: "toolCall" })).toBe("tool_call")
  })

  test("classifies structured transport codes before generic API wrappers", () => {
    for (const code of ["FailedToOpenSocket", "ConnectionRefused", "ECONNREFUSED"]) {
      expect(ProviderDiagnostic.classify({ message: "Cannot connect to API", codes: [code] }), code).toBe("connection")
    }
    for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
      expect(ProviderDiagnostic.classify({ message: "Cannot connect to API", codes: [code] }), code).toBe("dns")
    }
    for (const code of ["CERT_AUTHORITY_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) {
      expect(ProviderDiagnostic.classify({ message: "Cannot connect to API", codes: [code] }), code).toBe("tls")
    }
    for (const code of ["ETIMEDOUT", "ABORT_ERR"]) {
      expect(ProviderDiagnostic.classify({ message: "Cannot connect to API", codes: [code] }), code).toBe("timeout")
    }
    expect(ProviderDiagnostic.classify({ message: "Cannot connect to API" })).toBe("connection")
    expect(
      ProviderDiagnostic.classify({ statusCode: 401, message: "Cannot connect to API", codes: ["ENOTFOUND"] }),
    ).toBe("auth")
    expect(
      ProviderDiagnostic.classify({ message: "model not found; Cannot connect to API", codes: ["ENOTFOUND"] }),
    ).toBe("model")
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
      if (body.stream) {
        if (mode === "stream") {
          return new Response("data: not-json\n\ndata: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        }
        if (mode === "partial-stream") {
          return new Response(partialStreamResponse(), { headers: { "content-type": "text/event-stream" } })
        }
        return new Response(streamResponse(), { headers: { "content-type": "text/event-stream" } })
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

function toolResponse() {
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
              function: { name: "enterprise_probe", arguments: "{}" },
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
