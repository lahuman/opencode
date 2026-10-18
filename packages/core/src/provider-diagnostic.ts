export * as ProviderDiagnostic from "./provider-diagnostic.js"

import type { FailureKind, Input, Result } from "@opencode/schema/provider-diagnostic"
import type { Provider } from "@opencode/schema/provider"
import { AIError, LLM, LLMClient } from "@opencode/ai"
import { Cause, Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { Model } from "./model.js"
import { ModelResolver } from "./model-resolver.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "./effect/app-node-platform.js"
import { Enterprise } from "./enterprise.js"
type Stage = "basic" | "streaming" | "toolCall"
const decodeProbeInput = Schema.decodeUnknownOption(
  Schema.Union([Schema.Struct({}), Schema.fromJsonString(Schema.Struct({}))]),
  { onExcessProperty: "error" },
)
const decodeBasic = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      choices: Schema.Array(
        Schema.Struct({
          message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
          finish_reason: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
)
const decodeModelError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({ code: Schema.String }),
    }),
  ),
)

const connectionCodes = new Set([
  "FAILEDTOOPENSOCKET",
  "CONNECTIONCLOSED",
  "CONNECTIONREFUSED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT",
  "UND_ERR_SOCKET",
])
const dnsCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"])
const tlsCodes = new Set([
  "CERT_AUTHORITY_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
])
const timeoutCodes = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "ABORT_ERR",
  "ABORTERROR",
  "TIMEOUTERROR",
  "ERR_OPERATION_TIMED_OUT",
  "ERR_HTTP_REQUEST_TIMEOUT",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "PROVIDERHEADERTIMEOUTERROR",
  "PROVIDERRESPONSESTREAMTIMEOUTERROR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])
const modelCodes = new Set(["MODEL_NOT_FOUND", "DEPLOYMENT_NOT_FOUND", "MODEL_DOES_NOT_EXIST"])

export function classify(input: {
  statusCode?: number
  codes?: readonly string[]
  modelCode?: string
  stage?: Stage
}): FailureKind {
  const codes = (input.codes ?? []).map((code) => code.trim().toUpperCase())
  if (input.statusCode === 401 || input.statusCode === 403) return "auth"
  if (input.statusCode === 404 && input.modelCode && modelCodes.has(input.modelCode.trim().toUpperCase()))
    return "model"
  if (input.statusCode === 408 || input.statusCode === 504) return "timeout"
  if (codes.some((code) => dnsCodes.has(code))) return "dns"
  if (codes.some((code) => tlsCodes.has(code))) return "tls"
  if (codes.some((code) => timeoutCodes.has(code))) return "timeout"
  if (codes.some((code) => connectionCodes.has(code))) return "connection"
  if (input.stage === "streaming") return "stream"
  if (input.stage === "toolCall") return "tool_call"
  return "response"
}

const messages: Record<FailureKind, string> = {
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

export interface Interface {
  readonly run: (providerID: Provider.ID, input: Input) => Effect.Effect<Result>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderDiagnostic") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const llm = yield* LLMClient.Service
    return Service.of({
      run: Effect.fn("ProviderDiagnostic.run")(function* (providerID: Provider.ID, input: Input) {
        const state: { stage: Stage } = { stage: "basic" }
        return yield* Effect.gen(function* () {
          const selected = yield* resolver.resolve({ providerID, id: Model.ID.make(input.modelID) })
          if (!selected) return failure("basic", "model")
          const request = LLM.request({ model: selected.model, prompt: "Reply with OK." })
          if (Enterprise.enabled()) {
            const provider = Enterprise.settings().catalog.providers.find((provider) => provider.id === providerID)
            if (!provider) return failure("basic", "model")
            const url = Enterprise.requireURL(`${provider.baseURL.replace(/\/$/, "")}/chat/completions`)
            const response = yield* Effect.tryPromise(async (signal) => {
              const response = await fetch(url, {
                method: "POST",
                redirect: "manual",
                signal,
                headers: { "Content-Type": "application/json", ...Enterprise.requestHeaders(providerID) },
                body: JSON.stringify({
                  model: input.modelID,
                  stream: false,
                  messages: [{ role: "user", content: "Reply with OK." }],
                }),
              })
              return { ok: response.ok, status: response.status, body: await response.text() }
            }).pipe(Effect.timeout("15 seconds"))
            if (!response.ok)
              return failure(
                "basic",
                classify({
                  statusCode: response.status,
                  modelCode: Option.getOrUndefined(decodeModelError(response.body))?.error.code,
                }),
              )
            const basic = Option.getOrUndefined(decodeBasic(response.body))?.choices[0]
            if (!basic?.message.content?.trim() || basic.finish_reason === "content_filter")
              return failure("basic", "response")
          } else {
            const basic = yield* llm.generate(request).pipe(Effect.timeout("15 seconds"))
            if (!basic.text.trim()) return failure("basic", "response")
          }
          state.stage = "streaming"
          const streamed = yield* llm.stream(request).pipe(Stream.runCollect, Effect.timeout("15 seconds"))
          if (!streamed.some((event) => event.type === "text-delta" && event.text.trim()))
            return failure("streaming", "stream")
          if (streamed.some((event) => event.type === "provider-error")) return failure("streaming", "stream")
          if (
            streamed.some(
              (event) =>
                (event.type === "step-finish" || event.type === "finish") &&
                event.reason.normalized === "content-filter",
            )
          )
            return failure("streaming", "stream")
          if (input.checkToolCall) {
            state.stage = "toolCall"
            const result = yield* llm
              .generate(
                LLM.request({
                  model: selected.model,
                  prompt: "Call the enterprise_probe tool once.",
                  tools: [
                    {
                      name: "enterprise_probe",
                      description: "Test provider tool calling without executing a local action.",
                      inputSchema: { type: "object", properties: {}, additionalProperties: false },
                    },
                  ],
                  toolChoice: "required",
                }),
              )
              .pipe(Effect.timeout("15 seconds"))
            if (
              result.finishReason.normalized === "content-filter" ||
              !result.toolCalls.some(
                (call) => call.name === "enterprise_probe" && Option.isSome(decodeProbeInput(call.input)),
              )
            )
              return failure("toolCall", "tool_call")
          }
          return {
            ok: true,
            checks: { basic: "pass", streaming: "pass", toolCall: input.checkToolCall ? "pass" : "skipped" },
          } satisfies Result
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            const error = Cause.squash(cause)
            const reason = error instanceof AIError ? error.reason : undefined
            const chain = causes(error)
            return Effect.succeed(
              failure(
                state.stage,
                Cause.isTimeoutError(error) || reason?._tag === "Timeout"
                  ? "timeout"
                  : classify({
                      statusCode: reason?.http?.status,
                      modelCode: reason?.body
                        ? Option.getOrUndefined(decodeModelError(reason.body))?.error.code
                        : undefined,
                      codes: chain.flatMap((item) =>
                        item && typeof item === "object"
                          ? [
                              ...("code" in item && typeof item.code === "string" ? [item.code] : []),
                              ...(item instanceof Error ? [item.name] : []),
                            ]
                          : [],
                      ),
                      stage: state.stage,
                    }),
              ),
            )
          }),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [ModelResolver.node, llmClient] })

function causes(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (seen.has(error)) return []
  seen.add(error)
  if (!error || typeof error !== "object") return [error]
  const nested = [
    ...("cause" in error ? [error.cause] : []),
    ...("reason" in error ? [error.reason] : []),
    ...("lastError" in error ? [error.lastError] : []),
    ...("errors" in error && Array.isArray(error.errors) ? error.errors : []),
  ]
  return [error, ...nested.flatMap((item) => causes(item, seen))]
}

function failure(stage: Stage, kind: FailureKind): Result {
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
