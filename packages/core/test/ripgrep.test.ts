import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

describe("Ripgrep", () => {
  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves the configured executable validation error", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = process.env.OPENCODE_RIPGREP_PATH
            process.env.OPENCODE_RIPGREP_PATH = path.join(tmp.path, "missing-rg.exe")
            return previous
          }),
          () =>
            Effect.gen(function* () {
              const error = yield* (yield* Ripgrep.Service)
                .find({ cwd: tmp.path, pattern: "*", limit: 10 })
                .pipe(Effect.flip)
              expect(error.message).toBe(
                `Configured ripgrep executable not found: ${path.join(tmp.path, "missing-rg.exe")}`,
              )
              expect(error.cause).toBeInstanceOf(globalThis.Error)
            }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env.OPENCODE_RIPGREP_PATH
                return
              }
              process.env.OPENCODE_RIPGREP_PATH = previous
            }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves a configured executable process creation failure", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const executable = path.join(tmp.path, process.platform === "win32" ? "invalid-rg.exe" : "invalid-rg")
          yield* Effect.promise(() => fs.writeFile(executable, "not an executable"))
          if (process.platform !== "win32") yield* Effect.promise(() => fs.chmod(executable, 0o644))
          const previous = process.env.OPENCODE_RIPGREP_PATH
          process.env.OPENCODE_RIPGREP_PATH = executable
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env.OPENCODE_RIPGREP_PATH
                return
              }
              process.env.OPENCODE_RIPGREP_PATH = previous
            }),
          )

          const error = yield* (yield* Ripgrep.Service)
            .find({ cwd: tmp.path, pattern: "*", limit: 10 })
            .pipe(Effect.flip)
          expect(error.message).not.toBe("ripgrep execution failed")
          expect(error.message.length).toBeGreaterThan(0)
          expect(error.cause).toBeInstanceOf(globalThis.Error)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves fiber interruption while ripgrep is running", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const executable = path.join(tmp.path, process.platform === "win32" ? "slow-rg.cmd" : "slow-rg")
          yield* Effect.promise(() =>
            fs.writeFile(
              executable,
              process.platform === "win32" ? "@echo off\r\n:wait\r\ngoto wait\r\n" : "#!/bin/sh\nsleep 30\n",
            ),
          )
          if (process.platform !== "win32") yield* Effect.promise(() => fs.chmod(executable, 0o755))
          const previous = process.env.OPENCODE_RIPGREP_PATH
          process.env.OPENCODE_RIPGREP_PATH = executable
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env.OPENCODE_RIPGREP_PATH
                return
              }
              process.env.OPENCODE_RIPGREP_PATH = previous
            }),
          )

          const fiber = yield* (yield* Ripgrep.Service)
            .find({ cwd: tmp.path, pattern: "*", limit: 10 })
            .pipe(Effect.forkChild)
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("does not split surrogate pairs in oversized line previews", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "unicode.txt"), `needle${"x".repeat(1_993)}😀\n`),
          )

          const matches = yield* (yield* Ripgrep.Service).grep({ cwd: tmp.path, pattern: "needle", limit: 10 })

          expect(matches[0]?.text).toBe(`needle${"x".repeat(1_993)}...`)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

})
