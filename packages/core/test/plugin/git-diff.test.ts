import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Environment } from "@opencode/core/environment/index"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { GitDiffTool } from "@opencode/core/tool/plugin/git-diff"
import { testEffect } from "../lib/effect"
import { toolIdentity } from "../lib/tool"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, AppNodeBuilder.build(CrossSpawnSpawner.node)))
const sessionID = Session.ID.make("ses_git_diff")

const fixture = Effect.gen(function* () {
  const location = yield* Location.Service
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", location.directory, ...args])
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git("init")
  const commit = () => {
    git("add", "--all")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture")
    return git("rev-parse", "HEAD")
  }
  for (const value of ["first", "second", "third"]) {
    yield* Effect.promise(() => Bun.write(path.join(location.directory, "literal[1].txt"), `${value}\n`))
    yield* Effect.promise(() => Bun.write(path.join(location.directory, "literal1.txt"), `decoy-${value}\n`))
    commit()
  }
  const base = git("rev-parse", "HEAD~2")
  const target = git("rev-parse", "HEAD~1")
  const head = git("rev-parse", "HEAD")
  yield* Effect.promise(() => Bun.write(path.join(location.directory, "literal[1].txt"), "uncommitted\n"))
  const index = yield* Effect.promise(() => Bun.file(path.join(location.directory, ".git", "index")).arrayBuffer())
  const registry = yield* Tool.Service
  const plugin = yield* Plugin.Service
  const spawner = yield* ChildProcessSpawner
  const environment = Environment.Service.of({
    files: Environment.makeFiles(Environment.makeLocalDriver(spawner)), spawner,
  })
  yield* GitDiffTool.Plugin.effect(yield* PluginHost.make(plugin)).pipe(Effect.provideService(Environment.Service, environment))
  const tools = yield* registry.snapshot()
  const run = (input: typeof GitDiffTool.Input.Type) => tools.execute({
    sessionID, ...toolIdentity,
    call: { type: "tool-call", id: "git-diff-call", name: "git_diff", input },
  })
  return { location, git, base, target, head, index, run }
})

it.live("compares exact committed snapshots and literal filenames without changing HEAD, index, or worktree", () => Effect.gen(function* () {
  const repo = yield* fixture
  const summary = yield* repo.run({ base: "HEAD~2", target: "HEAD~1" })
  expect(summary.output).toEqual({
    base: repo.base, target: repo.target,
    files: [
      { file: "literal1.txt", status: "M", additions: 1, deletions: 1 },
      { file: "literal[1].txt", status: "M", additions: 1, deletions: 1 },
    ],
  })
  const patch = yield* repo.run({ base: repo.base, target: repo.target, path: "literal[1].txt" })
  expect(patch.output.patch).toContain("+second")
  expect(patch.output.patch).not.toMatch(/third|uncommitted|decoy/)
  expect(repo.git("rev-parse", "HEAD")).toBe(repo.head)
  expect(yield* Effect.promise(() => Bun.file(path.join(repo.location.directory, "literal[1].txt")).text())).toBe("uncommitted\n")
  expect(new Uint8Array(yield* Effect.promise(() => Bun.file(path.join(repo.location.directory, ".git", "index")).arrayBuffer()))).toEqual(new Uint8Array(repo.index))
}))

it.live("rejects option-like revisions and paths outside the repository through the real tool boundary", () => Effect.gen(function* () {
  const repo = yield* fixture
  for (const input of [
    { base: "--help", target: repo.target },
    { base: repo.base, target: "missing-revision" },
    { base: repo.base, target: repo.target, path: "../outside.txt" },
    { base: repo.base, target: repo.target, path: path.resolve(repo.location.directory, "literal[1].txt") },
  ]) {
    const result = yield* repo.run(input).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
  }
}))
