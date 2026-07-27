import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(RipgrepBinary.node))

describe("RipgrepBinary", () => {
  it.live("prefers an explicitly configured absolute executable path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const executable = path.join(tmp.path, "enterprise-rg.exe")
          yield* Effect.promise(() => fs.writeFile(executable, "fixture"))
          yield* withEnvironment("OPENCODE_RIPGREP_PATH", executable)(
            Effect.gen(function* () {
              expect(yield* (yield* RipgrepBinary.Service).filepath).toBe(executable)
            }),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a relative configured path without falling back", () =>
    withEnvironment("OPENCODE_RIPGREP_PATH", "relative/rg.exe")(
      Effect.gen(function* () {
        const error = yield* (yield* RipgrepBinary.Service).filepath.pipe(Effect.flip)
        expect(error.message).toBe("Configured ripgrep path must be absolute: relative/rg.exe")
      }),
    ),
  )

  it.live("rejects a missing configured executable without falling back", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withEnvironment("OPENCODE_RIPGREP_PATH", path.join(tmp.path, "missing-rg.exe"))(
          Effect.gen(function* () {
            const error = yield* (yield* RipgrepBinary.Service).filepath.pipe(Effect.flip)
            expect(error.message).toBe(`Configured ripgrep executable not found: ${path.join(tmp.path, "missing-rg.exe")}`)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function withEnvironment(key: string, value: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env[key]
        process.env[key] = value
        return previous
      }),
      () => effect,
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env[key]
            return
          }
          process.env[key] = previous
        }),
    )
}
