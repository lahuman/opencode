import { createInterface } from "node:readline"
import { Effect, Schema } from "effect"
import { Enterprise } from "@opencode/core/enterprise"

const Bootstrap = Schema.Struct({
  password: Schema.String.check(Schema.isMinLength(16)),
  catalog: Schema.Unknown,
  credentials: Schema.Unknown,
})

// A dedicated desktop child receives secrets over its private stdin pipe, never argv or env.
export const readEnterpriseBootstrap = Effect.gen(function* () {
  const text = yield* Effect.callback<string, Error>((resume) => {
    const lines = createInterface({ input: process.stdin, terminal: false })
    const done = (text: string) => resume(Effect.succeed(text))
    const closed = () => resume(Effect.fail(new Error("Enterprise bootstrap pipe closed")))
    lines.once("line", done)
    lines.once("close", closed)
    return Effect.sync(() => {
      lines.off("line", done)
      lines.off("close", closed)
      lines.close()
      process.stdin.pause()
    })
  }).pipe(Effect.timeout("30 seconds"))
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Bootstrap))(text).pipe(
    Effect.mapError(() => new Error("Invalid enterprise desktop bootstrap")),
  )
  process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG = JSON.stringify(value.catalog)
  yield* Effect.try({
    try: () => {
      Enterprise.settings()
      Enterprise.setCredentials(value.credentials)
    },
    catch: () => new Error("Invalid enterprise desktop policy or credentials"),
  })
  return { password: value.password }
})
