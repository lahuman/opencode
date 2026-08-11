import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "@/agent/agent"
import { Git } from "@/git"
import { MessageID, SessionID } from "@/session/schema"
import { GitDiffTool } from "@/tool/git-diff"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node, Truncate.node, Agent.node])))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_git-diff"),
  messageID: MessageID.make("msg_git-diff"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.die(new Error("git_diff requested permission")),
}

const git = Effect.fn("GitDiffToolTest.git")(function* (cwd: string, ...args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})

const history = Effect.fn("GitDiffToolTest.history")(function* (directory: string) {
  yield* Effect.promise(() => fs.mkdir(path.join(directory, "nested"), { recursive: true }))
  yield* Effect.promise(() =>
    Promise.all([
      Bun.write(path.join(directory, "middle.txt"), "before\n"),
      Bun.write(path.join(directory, "stable.txt"), "stable\n"),
      Bun.write(path.join(directory, "zeta.txt"), "removed\n"),
      Bun.write(path.join(directory, "nested", "changed.txt"), "before\n"),
    ]),
  )
  yield* git(directory, "add", ".")
  yield* git(directory, "commit", "-m", "base")
  yield* git(directory, "tag", "base-revision")

  yield* Effect.promise(() =>
    Promise.all([
      Bun.write(path.join(directory, "alpha.txt"), "added\n"),
      Bun.write(path.join(directory, "middle.txt"), "after\nmore\n"),
      Bun.write(path.join(directory, "nested", "changed.txt"), "after\n"),
      Bun.file(path.join(directory, "zeta.txt")).delete(),
    ]),
  )
  yield* git(directory, "add", "-A")
  yield* git(directory, "commit", "-m", "target")
  yield* git(directory, "tag", "target-revision")
})

const init = Effect.fn("GitDiffToolTest.init")(function* () {
  const info = yield* GitDiffTool
  return yield* info.init()
})

const failureMessage = Effect.fn("GitDiffToolTest.failureMessage")(function* (
  effect: Effect.Effect<unknown, unknown>,
) {
  const exit = yield* effect.pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return ""
  return Cause.prettyErrors(exit.cause)[0]?.message ?? Cause.pretty(exit.cause)
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.git_diff", () => {
  it.instance(
    "returns a sorted summary and resolved commit metadata without patches",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const tool = yield* init()
        const result = yield* tool.execute({ base: "base-revision", target: "target-revision" }, ctx)
        const files = JSON.parse(result.output)

        expect(files.map((file: { file: string }) => file.file)).toEqual([
          "alpha.txt",
          "middle.txt",
          "nested/changed.txt",
          "zeta.txt",
        ])
        expect(files).toEqual([
          { file: "alpha.txt", status: "added", additions: 1, deletions: 0 },
          { file: "middle.txt", status: "modified", additions: 2, deletions: 1 },
          { file: "nested/changed.txt", status: "modified", additions: 1, deletions: 1 },
          { file: "zeta.txt", status: "deleted", additions: 0, deletions: 1 },
        ])
        expect(result.output).not.toContain("diff --git")
        expect(result.metadata.base).toMatch(/^[0-9a-f]{40}$/)
        expect(result.metadata.target).toMatch(/^[0-9a-f]{40}$/)
        expect(result.metadata.files).toBe(4)
        expect(result.title).toBe(`${result.metadata.base.slice(0, 12)}..${result.metadata.target.slice(0, 12)}`)
      }),
    { git: true, init: history },
  )

  it.instance(
    "returns only the requested exact file patch",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const tool = yield* init()
        const summary = yield* tool.execute({ base: "base-revision", target: "target-revision" }, ctx)
        const files = JSON.parse(summary.output) as Array<{ file: string }>
        expect(files.some((file) => file.file === "middle.txt")).toBe(true)

        const result = yield* tool.execute(
          { base: summary.metadata.base, target: summary.metadata.target, path: "./middle.txt" },
          ctx,
        )
        expect(result.title).toBe("middle.txt")
        expect(result.metadata.path).toBe("middle.txt")
        expect(result.output).toContain("diff --git a/middle.txt b/middle.txt")
        expect(result.output).not.toContain("alpha.txt")
        expect(result.output).not.toContain("zeta.txt")
      }),
    { git: true, init: history },
  )

  it.instance(
    "returns stable no-change output for identical commits and unchanged paths",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const tool = yield* init()
        const summary = yield* tool.execute({ base: "base-revision", target: "base-revision" }, ctx)
        expect(summary.output).toBe("[]")
        expect(summary.metadata.files).toBe(0)

        const changed = yield* tool.execute({ base: "base-revision", target: "target-revision" }, ctx)
        const unchanged = yield* tool.execute(
          { base: changed.metadata.base, target: changed.metadata.target, path: "stable.txt" },
          ctx,
        )
        const directory = yield* tool.execute(
          { base: changed.metadata.base, target: changed.metadata.target, path: "nested" },
          ctx,
        )
        expect(unchanged.output).toBe("No changes for stable.txt.")
        expect(directory.output).toBe("No changes for nested.")
      }),
    { git: true, init: history },
  )

  it.instance("rejects a non-Git worktree", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const tool = yield* init()
      expect(yield* failureMessage(tool.execute({ base: "HEAD~1", target: "HEAD" }, ctx))).toContain(
        "git_diff requires a Git worktree",
      )
    }),
  )

  it.instance(
    "rejects absolute and escaping paths before Git execution",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const tool = yield* init()
        expect(
          yield* failureMessage(
            tool.execute({ base: "missing-base", target: "missing-target", path: path.join(test.directory, "x") }, ctx),
          ),
        ).toContain("Path must be repository-relative")
        expect(
          yield* failureMessage(
            tool.execute({ base: "missing-base", target: "missing-target", path: "../outside.txt" }, ctx),
          ),
        ).toContain("Path must stay within the worktree")
      }),
    { git: true },
  )

  it.instance(
    "reports invalid base and target separately",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const tool = yield* init()
        expect(yield* failureMessage(tool.execute({ base: "missing-base", target: "HEAD" }, ctx))).toContain(
          "Invalid base revision: missing-base",
        )
        expect(yield* failureMessage(tool.execute({ base: "HEAD", target: "missing-target" }, ctx))).toContain(
          "Invalid target revision: missing-target",
        )
      }),
    { git: true },
  )

  it.instance(
    "uses common truncation for an oversized patch",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const tool = yield* init()
        const summary = yield* tool.execute({ base: "large-base", target: "large-target" }, ctx)
        const result = yield* tool.execute(
          { base: summary.metadata.base, target: summary.metadata.target, path: "large.txt" },
          ctx,
        )

        expect(result.metadata.truncated).toBe(true)
        expect(result.metadata.outputPath).toBeString()
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
        expect(yield* Effect.promise(() => Bun.file(result.metadata.outputPath!).text())).toContain("line-5999")
      }),
    {
      git: true,
      init: (directory) =>
        Effect.gen(function* () {
          yield* git(directory, "tag", "large-base")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(directory, "large.txt"),
              Array.from({ length: 6000 }, (_, index) => `line-${index}`).join("\n"),
            ),
          )
          yield* git(directory, "add", "large.txt")
          yield* git(directory, "commit", "-m", "large")
          yield* git(directory, "tag", "large-target")
        }),
    },
  )

  it.instance(
    "does not request permission",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const tool = yield* init()
        const result = yield* tool.execute({ base: "base-revision", target: "target-revision" }, ctx)
        expect(result.metadata.files).toBe(4)
      }),
    { git: true, init: history },
  )
})
