export * as GitDiff from "./git-diff.js"

import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { collectStream } from "@opencode/util/process"
import { gitExecutable } from "../util/git-executable.js"

export const run = Effect.fn("GitDiff.run")(function* (
  spawner: ChildProcessSpawner["Service"],
  cwd: string,
  args: readonly string[],
) {
  const child = yield* spawner.spawn(ChildProcess.make(gitExecutable, [
    "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args,
  ], {
    cwd,
    env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
    extendEnv: true,
    stdin: "ignore",
  }))
  const [stdout, stderr, code] = yield* Effect.all([
    collectStream(child.stdout, 64 * 1024 * 1024),
    collectStream(child.stderr, 64 * 1024),
    child.exitCode,
  ], { concurrency: "unbounded" })
  if (code !== 0) return yield* Effect.fail(new Error(stderr.buffer.toString("utf8").trim() || `Git exited with code ${code}`))
  if (stdout.truncated) return yield* Effect.fail(new Error("Git output exceeds the supported size"))
  return stdout.buffer.toString("utf8")
}, Effect.scoped)

export function normalizePath(worktree: string, input: string) {
  if (path.isAbsolute(input)) throw new Error("Path must be repository-relative")
  const relative = path.relative(worktree, path.resolve(worktree, input))
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Path must identify one file within the worktree")
  return relative.split(path.sep).join("/")
}
