export * as GitDiffTool from "./git-diff.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Environment } from "../../environment/index.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { GitDiff } from "../git-diff.js"
import DESCRIPTION from "../git-diff.txt" with { type: "text" }

export const Input = Schema.Struct({
  base: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  path: Schema.optionalKey(Schema.NonEmptyString),
})
const File = Schema.Struct({ file: Schema.String, status: Schema.String, additions: Schema.Int, deletions: Schema.Int })
const Output = Schema.Struct({
  base: Schema.String,
  target: Schema.String,
  path: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Array(File)),
  patch: Schema.optionalKey(Schema.String),
})

export const Plugin = {
  id: "opencode.tool.git-diff",
  effect: Effect.fn("GitDiffTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    yield* ctx.tool.transform((editor) => editor.add({
      name: "git_diff",
      options: { codemode: false },
      description: DESCRIPTION,
      input: Input,
      output: Output,
      execute: (input, context) => Effect.gen(function* () {
        const run = (cwd: string, args: readonly string[]) => GitDiff.run(environment.spawner, cwd, args)
        const root = (yield* run(location.directory, ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "")
        const directory = yield* access.resolve({ path: root, kind: "directory" })
        yield* access.authorizeExternal([directory], context)
        yield* permission.assert({
          action: "git_diff", resources: ["*"], save: ["*"],
          sessionID: context.sessionID, agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })
        const resolve = (revision: string) => run(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).pipe(
          Effect.map((value) => value.trim()),
          Effect.filterOrFail((value) => /^[0-9a-f]{40,64}$/.test(value), () => new Error("Invalid commit revision")),
        )
        const base = yield* resolve(input.base)
        const target = yield* resolve(input.target)
        const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"]
        const names = (yield* run(root, [...args, "--name-status", "-z", base, target, "--"])).split("\0").filter(Boolean)
        const numbers = (yield* run(root, [...args, "--numstat", "-z", base, target, "--"])).split("\0").filter(Boolean)
        const statistics = new Map(numbers.map((value) => {
          const first = value.indexOf("\t")
          const second = value.indexOf("\t", first + 1)
          return [value.slice(second + 1), {
            additions: Number.parseInt(value.slice(0, first), 10) || 0,
            deletions: Number.parseInt(value.slice(first + 1, second), 10) || 0,
          }] as const
        }))
        const files = names.flatMap((status, index) => index % 2 ? [] : [{
          file: names[index + 1], status,
          additions: statistics.get(names[index + 1])?.additions ?? 0,
          deletions: statistics.get(names[index + 1])?.deletions ?? 0,
        }]).toSorted((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
        if (!input.path) return {
          output: { base, target, files },
          content: files.length ? files.map((file) => `${file.status}\t+${file.additions}\t-${file.deletions}\t${file.file}`).join("\n") : "No changes.",
          metadata: { base, target, files: files.length },
        }
        const file = GitDiff.normalizePath(root, input.path)
        const patch = files.some((entry) => entry.file === file)
          ? yield* run(root, [...args, "--patch", base, target, "--", file])
          : `No changes for ${file}.`
        return { output: { base, target, path: file, patch }, content: patch, metadata: { base, target, path: file } }
      }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Unable to compare Git commits", error }))),
    })).pipe(Effect.orDie)
  }),
}
