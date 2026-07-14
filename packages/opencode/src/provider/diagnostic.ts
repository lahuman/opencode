export * as ProviderDiagnostic from "./diagnostic"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { APICallError, generateText, jsonSchema, streamText, tool } from "ai"
import { Cause, Context, Effect, Layer, Schema } from "effect"
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

export function classify(input: {
  statusCode?: number
  message: string
  codes?: readonly string[]
  stage?: Stage
}): typeof FailureKind.Type {
  const message = input.message.toLowerCase()
  const transport = [message, ...(input.codes ?? []).map((code) => code.toLowerCase())].join(" ")
  if (input.statusCode === 401 || input.statusCode === 403) return "auth"
  if (message.includes("model not found") || message.includes("unknown model") || message.includes("no such model"))
    return "model"
  if (transport.includes("enotfound") || transport.includes("eai_again")) return "dns"
  if (
    transport.includes("cert_") ||
    transport.includes("certificate") ||
    transport.includes("self signed") ||
    transport.includes("unable_to_verify") ||
    transport.includes("unable to verify")
  )
    return "tls"
  if (
    transport.includes("timed out") ||
    transport.includes("timeout") ||
    transport.includes("etimedout") ||
    transport.includes("abort_err") ||
    transport.includes("aborted")
  )
    return "timeout"
  if (
    transport.includes("failedtoopensocket") ||
    transport.includes("connectionrefused") ||
    transport.includes("econnrefused") ||
    transport.includes("econnreset") ||
    transport.includes("ehostunreach") ||
    transport.includes("fetch failed") ||
    transport.includes("socket hang up") ||
    transport.includes("cannot connect to api")
  )
    return "connection"
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

function failureResult(error: unknown): typeof Result.Type {
  const stage = isProbeError(error) ? error.stage : "basic"
  const chain = causeChain(isProbeError(error) ? error.cause : error)
  const api = chain.find((item) => APICallError.isInstance(item))
  const message = chain
    .flatMap((item) => (item instanceof Error ? [item.message] : typeof item === "string" ? [item] : []))
    .join(" ")
  const codes = chain.flatMap((item) =>
    item && typeof item === "object" && "code" in item && typeof item.code === "string" ? [item.code] : [],
  )
  const kind = chain.some((item) => Provider.ModelNotFoundError.isInstance(item))
    ? "model"
    : classify({ statusCode: APICallError.isInstance(api) ? api.statusCode : undefined, message, codes, stage })
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

export async function probe(
  model: Parameters<typeof generateText>[0]["model"],
  checkToolCall: boolean,
): Promise<typeof Result.Type> {
  try {
    await check("basic", async () => {
      const result = await generateText({
        model,
        prompt: "Reply with OK.",
        maxOutputTokens: 8,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(15_000),
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
        abortSignal: AbortSignal.timeout(15_000),
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
              inputSchema: jsonSchema({
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              }),
            }),
          },
          abortSignal: AbortSignal.timeout(15_000),
        })
        if (result.toolCalls.length === 0) throw new Error("Tool call was not returned")
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
          return yield* Effect.promise(() => probe(language, input.checkToolCall))
        }).pipe(Effect.catchCause((cause) => Effect.succeed(failureResult(Cause.squash(cause))))),
      ),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Provider.node] })
