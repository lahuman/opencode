export * as ProviderDiagnostic from "./diagnostic"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { APICallError, generateText, jsonSchema, streamText, tool } from "ai"
import { Context, Effect, Layer, Schema } from "effect"
import { Provider } from "./provider"

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

const CheckState = Schema.Literals(["pass", "fail", "skipped"])
export const Result = Schema.Struct({
  ok: Schema.Boolean,
  checks: Schema.Struct({
    basic: CheckState,
    streaming: CheckState,
    toolCall: CheckState,
  }),
  failure: Schema.optional(
    Schema.Struct({
      kind: FailureKind,
      message: Schema.String,
    }),
  ),
})

type Stage = "basic" | "streaming" | "toolCall"
type ProbeError = { stage: Stage; cause: unknown }

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
}): typeof FailureKind.Type {
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
  if (!error || typeof error !== "object") return [error]
  const nested = [
    ...("cause" in error ? [error.cause] : []),
    ...("lastError" in error ? [error.lastError] : []),
    ...("errors" in error && Array.isArray(error.errors) ? error.errors : []),
  ]
  return [error, ...nested.flatMap((item) => causeChain(item, seen))]
}

function modelCode(error: unknown) {
  if (!APICallError.isInstance(error)) return undefined
  if (!error.data || typeof error.data !== "object" || !("error" in error.data)) return undefined
  const detail = error.data.error
  if (!detail || typeof detail !== "object" || !("code" in detail) || typeof detail.code !== "string") return undefined
  return detail.code
}

function failureResult(error: unknown): typeof Result.Type {
  const stage = isProbeError(error) ? error.stage : "basic"
  const chain = causeChain(isProbeError(error) ? error.cause : error)
  const api = chain.find((item) => APICallError.isInstance(item))
  const codes = chain.flatMap((item) =>
    item && typeof item === "object"
      ? [
          ...("code" in item && typeof item.code === "string" ? [item.code] : []),
          ...(item instanceof Error ? [item.name] : []),
        ]
      : [],
  )
  const kind = chain.some((item) => Provider.ModelNotFoundError.isInstance(item))
    ? "model"
    : classify({
        statusCode: APICallError.isInstance(api) ? api.statusCode : undefined,
        codes,
        modelCode: modelCode(api),
        stage,
      })
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

function stageSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function probe(
  model: Parameters<typeof generateText>[0]["model"],
  checkToolCall: boolean,
  signal?: AbortSignal,
): Promise<typeof Result.Type> {
  try {
    await check("basic", async () => {
      const result = await generateText({
        model,
        prompt: "Reply with OK.",
        maxOutputTokens: 8,
        maxRetries: 0,
        abortSignal: stageSignal(signal),
      })
      if (!result.text.trim()) throw new Error("Basic response was empty")
    })
    await check("streaming", async () => {
      const errors: unknown[] = []
      const stream = streamText({
        model,
        prompt: "Reply with OK.",
        maxOutputTokens: 8,
        maxRetries: 0,
        abortSignal: stageSignal(signal),
        onError({ error }) {
          errors.push(error)
        },
      })
      const chunks: string[] = []
      for await (const chunk of stream.textStream) chunks.push(chunk)
      if (errors.length) throw errors[0]
      if (!chunks.join("").trim()) throw new Error("Streaming response was empty")
    })
    if (checkToolCall) {
      await check("toolCall", async () => {
        const result = await generateText({
          model,
          prompt: "Call the enterprise_probe tool once.",
          maxRetries: 0,
          toolChoice: "required",
          tools: {
            enterprise_probe: tool({
              inputSchema: jsonSchema(
                {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
                {
                  validate(value) {
                    if (
                      typeof value === "object" &&
                      value !== null &&
                      !Array.isArray(value) &&
                      Object.keys(value).length === 0
                    )
                      return { success: true, value: {} }
                    return { success: false, error: new Error("Diagnostic tool input must be an empty object") }
                  },
                },
              ),
            }),
          },
          abortSignal: stageSignal(signal),
        })
        if (!result.toolCalls.some((call) => call.toolName === "enterprise_probe" && call.invalid !== true))
          throw new Error("Tool call was not returned")
      })
    }
    return {
      ok: true,
      checks: {
        basic: "pass",
        streaming: "pass",
        toolCall: checkToolCall ? "pass" : "skipped",
      },
    }
  } catch (error) {
    return failureResult(error)
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
          return yield* Effect.promise((signal) => probe(language, input.checkToolCall, signal))
        }).pipe(Effect.catch((error) => Effect.succeed(failureResult(error)))),
      ),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Provider.node] })
