export * as ProviderDiagnostic from "./provider-diagnostic.js"

import { Schema } from "effect"

export const Input = Schema.Struct({ modelID: Schema.String, checkToolCall: Schema.Boolean })
export type Input = typeof Input.Type

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
export type FailureKind = typeof FailureKind.Type

const CheckState = Schema.Literals(["pass", "fail", "skipped"])
export const Result = Schema.Struct({
  ok: Schema.Boolean,
  checks: Schema.Struct({ basic: CheckState, streaming: CheckState, toolCall: CheckState }),
  failure: Schema.optional(Schema.Struct({ kind: FailureKind, message: Schema.String })),
}).annotate({ identifier: "ProviderDiagnosticResult" })
export type Result = typeof Result.Type
