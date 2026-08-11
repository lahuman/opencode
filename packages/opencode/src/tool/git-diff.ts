import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import DESCRIPTION from "./git-diff.txt"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  base: Schema.NonEmptyString.annotate({ description: "The older Git commit revision" }),
  target: Schema.NonEmptyString.annotate({ description: "The newer Git commit revision" }),
  path: Schema.optional(Schema.NonEmptyString).annotate({
    description: "One exact repository-relative file path returned by the summary",
  }),
})

type Metadata = {
  base: string
  target: string
  path?: string
  files?: number
  truncated?: boolean
  outputPath?: string
}

export const GitDiffTool = Tool.define<typeof Parameters, Metadata, Git.Service>(
  "git_diff",
  Effect.gen(function* () {
    const git = yield* Git.Service

    const run = Effect.fn("GitDiffTool.execute")(function* (params: Schema.Schema.Type<typeof Parameters>) {
      const instance = yield* InstanceState.context
      if (instance.project.vcs !== "git") return yield* Effect.fail(new Error("git_diff requires a Git worktree"))

      const file = params.path ? normalizePath(instance.worktree, params.path) : undefined
      const base = yield* git.resolveCommit(instance.worktree, params.base)
      if (!base) return yield* Effect.fail(new Error(`Invalid base revision: ${params.base}`))
      const target = yield* git.resolveCommit(instance.worktree, params.target)
      if (!target) return yield* Effect.fail(new Error(`Invalid target revision: ${params.target}`))

      const files = yield* git.changedFiles(instance.worktree, base, target)
      if (!file) {
        return {
          title: `${base.slice(0, 12)}..${target.slice(0, 12)}`,
          output: JSON.stringify(files, null, 2),
          metadata: { base, target, files: files.length },
        }
      }

      if (!files.some((item) => item.file === file)) {
        return {
          title: file,
          output: `No changes for ${file}.`,
          metadata: { base, target, path: file },
        }
      }

      return {
        title: file,
        output: yield* git.patchBetween(instance.worktree, base, target, file),
        metadata: { base, target, path: file },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) => run(params).pipe(Effect.orDie),
    }
  }),
)

function normalizePath(worktree: string, input: string) {
  if (path.isAbsolute(input)) throw new Error("Path must be repository-relative")
  const absolute = path.resolve(worktree, input)
  if (!FSUtil.contains(worktree, absolute)) throw new Error("Path must stay within the worktree")
  const relative = path.relative(worktree, absolute).split(path.sep).join("/")
  if (!relative) throw new Error("Path must identify one file from the summary")
  return relative
}
