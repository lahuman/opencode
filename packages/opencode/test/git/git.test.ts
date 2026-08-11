import { $ } from "bun"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"
const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const runGit = (cwd: string, ...args: string[]) => $`git ${args}`.cwd(cwd).quiet()
const gitText = async (cwd: string, ...args: string[]) => (await runGit(cwd, ...args).text()).trim()

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("Git", () => {
  it.live("branch() returns current branch name", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeDefined()
      expect(typeof branch).toBe("string")
    }),
  )

  it.live("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeUndefined()
    }),
  )

  it.live("branch() returns undefined for detached HEAD", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const hash = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(tmp.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git checkout --detach ${hash}`.cwd(tmp.path).quiet())
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeUndefined()
    }),
  )

  it.live("defaultBranch() uses init.defaultBranch when available", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch -M trunk`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git config init.defaultBranch trunk`.cwd(tmp.path).quiet())
      const git = yield* Git.Service
      const branch = yield* git.defaultBranch(tmp.path)
      expect(branch?.name).toBe("trunk")
      expect(branch?.ref).toBe("trunk")
    }),
  )

  it.live("status() handles special filenames", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "hello\n", "utf-8"))
      const git = yield* Git.Service
      const status = yield* git.status(tmp.path)
      expect(status).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "added",
          }),
        ]),
      )
    }),
  )

  it.live("diff(), stats(), and mergeBase() parse tracked changes", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch -M main`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "before\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git checkout -b feature/test`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "after\n", "utf-8"))

      const git = yield* Git.Service
      const [base, diff, stats] = yield* Effect.all([
        git.mergeBase(tmp.path, "main"),
        git.diff(tmp.path, "HEAD"),
        git.stats(tmp.path, "HEAD"),
      ])

      expect(base).toBeTruthy()
      expect(diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "modified",
          }),
        ]),
      )
      expect(stats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            additions: 1,
            deletions: 1,
          }),
        ]),
      )
    }),
  )

  it.live("patch() returns capped native patch output", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "before\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "other.txt"), "old\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "after\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "other.txt"), "new\n", "utf-8"))

      const git = yield* Git.Service
      const [patch, all, capped] = yield* Effect.all([
        git.patch(tmp.path, "HEAD", weird, { context: 2_147_483_647 }),
        git.patchAll(tmp.path, "HEAD", { context: 2_147_483_647 }),
        git.patch(tmp.path, "HEAD", weird, { maxOutputBytes: 1 }),
      ])

      expect(patch.truncated).toBe(false)
      expect(patch.text).toContain("diff --git")
      expect(patch.text).toContain("-before")
      expect(patch.text).toContain("+after")
      expect(all.truncated).toBe(false)
      expect(all.text).toContain("diff --git")
      expect(all.text).toContain("other.txt")
      expect(all.text).toContain("+new")
      expect(capped.truncated).toBe(true)
      expect(capped.text).toBe("")
    }),
  )

  it.live("patchUntracked() and statUntracked() handle added files", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "one\ntwo\n", "utf-8"))

      const git = yield* Git.Service
      const [patch, stat] = yield* Effect.all([
        git.patchUntracked(tmp.path, weird, { context: 2_147_483_647 }),
        git.statUntracked(tmp.path, weird),
      ])

      expect(patch.truncated).toBe(false)
      expect(patch.text).toContain("diff --git")
      expect(patch.text).toContain("+one")
      expect(patch.text).toContain("+two")
      expect(stat).toEqual(expect.objectContaining({ file: weird, additions: 2, deletions: 0 }))
    }),
  )

  it.live("show() returns empty text for binary blobs", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "bin.dat"), new Uint8Array([0, 1, 2, 3])))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add binary"`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      const text = yield* git.show(tmp.path, "HEAD", "bin.dat")
      expect(text).toBe("")
    }),
  )

  it.live("resolveCommit() resolves commit revision forms", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "first.txt"), "first\n", "utf-8"))
      yield* Effect.promise(() => runGit(tmp.path, "add", "."))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "first"))
      const first = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "second.txt"), "second\n", "utf-8"))
      yield* Effect.promise(() => runGit(tmp.path, "add", "."))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "second"))
      const second = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "third.txt"), "third\n", "utf-8"))
      yield* Effect.promise(() => runGit(tmp.path, "add", "."))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "third"))
      const third = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))
      yield* Effect.promise(() => runGit(tmp.path, "branch", "comparison", first))
      yield* Effect.promise(() => runGit(tmp.path, "tag", "-a", "comparison-tag", "-m", "tagged", second))

      const git = yield* Git.Service
      const revisions = yield* Effect.all([
        git.resolveCommit(tmp.path, third),
        git.resolveCommit(tmp.path, third.slice(0, 12)),
        git.resolveCommit(tmp.path, "comparison"),
        git.resolveCommit(tmp.path, "comparison-tag"),
        git.resolveCommit(tmp.path, "HEAD~1"),
      ])

      expect(revisions).toEqual([third, third, first, second, second])
    }),
  )

  it.live("resolveCommit() rejects non-commits and option-shaped revisions", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      const revisions = yield* Effect.all([
        git.resolveCommit(tmp.path, "HEAD^{tree}"),
        git.resolveCommit(tmp.path, "missing"),
        git.resolveCommit(tmp.path, "--output=owned"),
      ])

      expect(revisions).toEqual([undefined, undefined, undefined])
      expect(
        yield* Effect.promise(() =>
          fs
            .stat(path.join(tmp.path, "owned"))
            .then(() => true)
            .catch(() => false),
        ),
      ).toBe(false)
    }),
  )

  it.live("changedFiles() returns a sorted two-commit summary", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "Z-modified.txt"), "before\nremoved\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "deleted.txt"), "gone\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "rename-old.txt"), "same\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "binary.dat"), new Uint8Array([0, 1, 2])))
      yield* Effect.promise(() => runGit(tmp.path, "add", "."))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "base"))
      const base = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))

      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "Z-modified.txt"), "after\n", "utf-8"))
      yield* Effect.promise(() => fs.rm(path.join(tmp.path, "deleted.txt")))
      yield* Effect.promise(() => fs.rename(path.join(tmp.path, "rename-old.txt"), path.join(tmp.path, "rename-new.txt")))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "binary.dat"), new Uint8Array([0, 3, 4])))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a-added.txt"), "one\ntwo\n", "utf-8"))
      yield* Effect.promise(() => runGit(tmp.path, "add", "."))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "target"))
      const target = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))

      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "Z-modified.txt"), "working tree\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "untracked.txt"), "untracked\n", "utf-8"))

      const git = yield* Git.Service
      const [changed, identical] = yield* Effect.all([
        git.changedFiles(tmp.path, base, target),
        git.changedFiles(tmp.path, target, target),
      ])

      expect(changed).toEqual([
        { file: "Z-modified.txt", status: "modified", additions: 1, deletions: 2 },
        { file: "a-added.txt", status: "added", additions: 2, deletions: 0 },
        { file: "binary.dat", status: "modified", additions: 0, deletions: 0 },
        { file: "deleted.txt", status: "deleted", additions: 0, deletions: 1 },
        { file: "rename-new.txt", status: "added", additions: 1, deletions: 0 },
        { file: "rename-old.txt", status: "deleted", additions: 0, deletions: 1 },
      ])
      expect(identical).toEqual([])
    }),
  )

  it.live("patchBetween() treats pathspec syntax literally", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "file[1].txt"), "before\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "file1.txt"), "unchanged\n", "utf-8"))
      yield* Effect.promise(() => runGit(tmp.path, "add", "."))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "base"))
      const base = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "file[1].txt"), "after\n", "utf-8"))
      yield* Effect.promise(() => runGit(tmp.path, "add", "."))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "target"))
      const target = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))

      const git = yield* Git.Service
      const [patch, unchanged] = yield* Effect.all([
        git.patchBetween(tmp.path, base, target, "file[1].txt"),
        git.patchBetween(tmp.path, base, target, "file1.txt"),
      ])

      expect(patch).toContain("file[1].txt")
      expect(patch).not.toContain("file1.txt")
      expect(patch).toContain("-before")
      expect(patch).toContain("+after")
      expect(unchanged).toBe("")
    }),
  )

  it.live("patchBetween() disables external diff and textconv helpers", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const marker = path.join(tmp.path, "helper-ran")
      const helper = path.join(tmp.path, "helper.ts")
      yield* Effect.promise(() =>
        fs.writeFile(helper, `await Bun.write(${JSON.stringify(marker)}, "ran")\nprocess.exit(1)\n`, "utf-8"),
      )
      yield* Effect.promise(() =>
        runGit(tmp.path, "config", "diff.external", `bun \"${helper.replaceAll("\\", "/")}\"`),
      )
      yield* Effect.promise(() =>
        runGit(tmp.path, "config", "diff.trap.textconv", `bun \"${helper.replaceAll("\\", "/")}\"`),
      )
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitattributes"), "*.txt diff=trap\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "tracked.txt"), "before\n", "utf-8"))
      yield* Effect.promise(() => runGit(tmp.path, "add", ".gitattributes", "tracked.txt"))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "base"))
      const base = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "tracked.txt"), "after\n", "utf-8"))
      yield* Effect.promise(() => runGit(tmp.path, "add", "tracked.txt"))
      yield* Effect.promise(() => runGit(tmp.path, "commit", "--no-gpg-sign", "-m", "target"))
      const target = yield* Effect.promise(() => gitText(tmp.path, "rev-parse", "HEAD"))

      const git = yield* Git.Service
      const patch = yield* git.patchBetween(tmp.path, base, target, "tracked.txt")

      expect(patch).toContain("diff --git")
      expect(patch).toContain("-before")
      expect(patch).toContain("+after")
      expect(
        yield* Effect.promise(() =>
          fs
            .stat(marker)
            .then(() => true)
            .catch(() => false),
        ),
      ).toBe(false)
    }),
  )

  it.live("read-only comparisons do not lazily fetch missing objects", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const source = path.join(tmp.path, "source")
      const remote = path.join(tmp.path, "remote.git")
      const clone = path.join(tmp.path, "partial")
      yield* Effect.promise(() => fs.mkdir(source))
      yield* Effect.promise(() => runGit(source, "init", "--initial-branch=main"))
      yield* Effect.promise(() => runGit(source, "config", "user.email", "test@opencode.test"))
      yield* Effect.promise(() => runGit(source, "config", "user.name", "Test"))
      yield* Effect.promise(() => runGit(source, "config", "commit.gpgsign", "false"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "before\n", "utf-8"))
      yield* Effect.promise(() => runGit(source, "add", "."))
      yield* Effect.promise(() => runGit(source, "commit", "--no-gpg-sign", "-m", "base"))
      const base = yield* Effect.promise(() => gitText(source, "rev-parse", "HEAD"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "after\n", "utf-8"))
      yield* Effect.promise(() => runGit(source, "add", "."))
      yield* Effect.promise(() => runGit(source, "commit", "--no-gpg-sign", "-m", "target"))
      const target = yield* Effect.promise(() => gitText(source, "rev-parse", "HEAD"))
      const missingBlob = yield* Effect.promise(() => gitText(source, "rev-parse", `${target}:tracked.txt`))

      yield* Effect.promise(() => runGit(tmp.path, "init", "--bare", "--initial-branch=main", remote))
      yield* Effect.promise(() => runGit(remote, "config", "uploadpack.allowFilter", "true"))
      yield* Effect.promise(() => runGit(source, "remote", "add", "origin", pathToFileURL(remote).href))
      yield* Effect.promise(() => runGit(source, "push", "-u", "origin", "HEAD:main"))
      yield* Effect.promise(() =>
        runGit(tmp.path, "clone", "--filter=blob:none", "--no-checkout", pathToFileURL(remote).href, clone),
      )

      const git = yield* Git.Service
      const error = yield* git.patchBetween(clone, base, target, "tracked.txt").pipe(Effect.flip)
      expect(error).toBeInstanceOf(Error)
      const blob = yield* Effect.promise(() =>
        runGit(clone, "cat-file", "-e", missingBlob)
          .env({ ...process.env, GIT_NO_LAZY_FETCH: "1" })
          .nothrow(),
      )
      expect(blob.exitCode).not.toBe(0)

      yield* Effect.promise(() => fs.writeFile(path.join(source, "future.txt"), "future\n", "utf-8"))
      yield* Effect.promise(() => runGit(source, "add", "."))
      yield* Effect.promise(() => runGit(source, "commit", "--no-gpg-sign", "-m", "future"))
      const future = yield* Effect.promise(() => gitText(source, "rev-parse", "HEAD"))
      yield* Effect.promise(() => runGit(source, "push", "origin", "HEAD:main"))
      const ref = path.join(clone, ".git", "refs", "remotes", "origin", "future")
      yield* Effect.promise(() => fs.mkdir(path.dirname(ref), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(ref, `${future}\n`, "utf-8"))

      expect(yield* git.resolveCommit(clone, "refs/remotes/origin/future")).toBeUndefined()
      const commit = yield* Effect.promise(() =>
        runGit(clone, "cat-file", "-e", future)
          .env({ ...process.env, GIT_NO_LAZY_FETCH: "1" })
          .nothrow(),
      )
      expect(commit.exitCode).not.toBe(0)
    }),
  )
})
