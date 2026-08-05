import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { decisionAllowed, guard, normalize, preflight, rulesetDigest } from "@/permission/plan-review"
import { tmpdir } from "../fixture/fixture"
import { mkdir, symlink, unlink } from "node:fs/promises"
import path from "node:path"

const context = {
  agent: {} as never,
  agentID: "plan",
  model: {} as never,
  userMessageID: "user" as never,
  assistantMessageID: "assistant" as never,
  callID: "call",
  directory: process.cwd(),
  abort: new AbortController().signal,
  approvalMode: "auto_review" as const,
  messages: [],
  rulesetDigest: "rules",
}

const request = (permission: string, patterns = [permission], metadata: Record<string, unknown> = {}) => ({
  id: "permission" as never,
  sessionID: "session" as never,
  permission,
  patterns,
  metadata,
  always: [],
})

describe("plan permission guard", () => {
  for (const permission of ["edit", "write", "apply_patch"]) {
    test(`denies ${permission}`, async () => {
      expect(await Effect.runPromise(guard({ request: request(permission), context }))).toEqual({
        type: "deny",
        reason: "Plan mode cannot modify files.",
        alternative: "Switch to Build mode to make changes.",
      })
    })
  }

  test("does not treat todowrite as repository mutation", async () => {
    expect(await Effect.runPromise(guard({ request: request("todowrite"), context }))).toEqual({ type: "pass" })
  })
})

describe("plan shell preflight", () => {
  const deny = [
    "rm -rf build",
    "Remove-Item -Recurse build",
    "del /s build",
    "format C:",
    "git reset --hard",
    "git reset --soft HEAD~1",
    "git clean -fd",
    "echo value > file",
    "echo value >> file",
    "cat file | tee copy",
    "Get-Content file | Tee-Object copy",
    "Get-Content file | Out-File copy",
    "touch file",
    "mkdir build",
    "cp source target",
    "mv source target",
    "Copy-Item source target",
    "Move-Item source target",
    "Rename-Item source target",
    "Set-Content file value",
    "Add-Content file value",
    "sed -i s/a/b/ file",
    "git add file",
    "git rm file",
    "git mv a b",
    "git apply patch",
    "git am patch",
    "git revert HEAD",
    "git init",
    "git config user.name x",
    "git config --unset user.name",
    "git remote add origin url",
    "git submodule update --init",
    "git sparse-checkout init",
    "git bisect start",
    "git stash push",
    "git branch new",
    "git branch -D old",
    "git tag v1",
    "git tag -d old",
    "git worktree add ../copy",
    "git update-index --assume-unchanged file",
    "git fetch",
    "git pull",
    "git push",
    "git checkout branch",
    "git switch branch",
    "git restore file",
    "git commit -m msg",
    "git merge branch",
    "git rebase branch",
    "git cherry-pick HEAD",
    "git diff --output=changes.patch",
    "git clone https://example.com/repo.git",
    "npm install package",
    "bun run generate",
    "go generate ./...",
    "prisma generate",
    "vercel deploy",
    "kubectl apply -f deployment.yaml",
    "helm upgrade app chart",
    "docker push example/image",
    "aws s3 cp file s3://bucket/file",
    "curl -d value https://example.com",
    "curl -o output https://example.com",
    "wget https://example.com",
    "Invoke-WebRequest -OutFile output https://example.com",
    "Invoke-RestMethod -Method Post https://example.com",
    "bun test -u test/unit.test.ts",
    "eslint --fix src",
    "sudo cat file",
    "Set-ExecutionPolicy Unrestricted",
  ]

  for (const command of deny) {
    test(`denies hazardous command: ${command}`, async () => {
      const result = await Effect.runPromise(
        preflight({
          request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: process.cwd() }),
          context,
        }),
      )
      expect(result.type).toBe("deny")
    })
  }

  const ask = [
    "cat .env.local",
    "cat .npmrc",
    "cat ~/.netrc",
    "cat ~/.git-credentials",
    "cat ~/.docker/config.json",
    "cat ~/.kube/config",
    "cat application_default_credentials.json",
    "cat service-account.json",
    "cat ~/.azure/accessTokens.json",
    "cat ~/.azure/azureProfile.json",
    "cat ~/.azure/msal_token_cache.json",
    "cat ~/.ssh/id_ed25519",
    "cat ~/.aws/credentials",
    "cat /proc/123/environ",
    "Get-ChildItem Env:",
    "gci Env:",
    "dir Env:",
    "env",
    "printenv",
    "set",
    "export -p",
    "echo $GITHUB_TOKEN",
    "git credential fill",
    "gh auth token",
    "gcloud auth print-access-token",
    "az account get-access-token",
    "kubectl config view --raw",
    "aws configure get aws_secret_access_key",
    "npm config get //registry.npmjs.org/:_authToken",
    "curl https://example.com",
    "Invoke-WebRequest https://example.com",
    "alias inspect=cat; inspect file",
    "function inspect { cat file; }",
    "Get-Content inside,../outside",
    "cat {inside,../outside}",
    "powershell -encodedCommand ZQBjAGgAbwA=",
    "cat *.env",
    "git unknown-subcommand",
    "git config user.name",
    "git branch --unknown-read-flag",
    "bun test",
    "find . -exec cat {} ;",
  ]

  for (const command of ask) {
    test(`asks for ambiguous or sensitive command: ${command}`, async () => {
      const result = await Effect.runPromise(
        preflight({
          request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: process.cwd() }),
          context,
        }),
      )
      expect(result.type).toBe("ask")
    })
  }

  for (const command of [
    "git status",
    "git branch",
    "git branch -vv",
    "git tag",
    "git tag -n",
    "git stash list",
    "git worktree list",
    "git config --get user.name",
    "git remote",
    "git remote -v",
    "bun test test/unit.test.ts",
    "bun typecheck",
  ]) {
    test(`reviews documented read-only command: ${command}`, async () => {
      const result = await Effect.runPromise(
        preflight({
          request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: process.cwd() }),
          context,
        }),
      )
      expect(result.type).toBe("review")
    })
  }

  test("uses the worst outcome from every ordered pattern", async () => {
    const result = await Effect.runPromise(
      preflight({
        request: request("bash", ["git status", "git reset --hard"], {
          command: "git status && git reset --hard",
          shell: "bash",
          parsed: true,
          cwd: process.cwd(),
        }),
        context,
      }),
    )
    expect(result.type).toBe("deny")
  })

  test("asks for compound working-directory changes", async () => {
    const result = await Effect.runPromise(
      preflight({
        request: request("bash", ["cat ../outside/secret"], {
          command: "cd .. && cat ../outside/secret",
          shell: "bash",
          parsed: true,
          cwd: process.cwd(),
        }),
        context,
      }),
    )
    expect(result.type).toBe("ask")
  })

  for (const command of [
    "cd .. && cat ../outside/plain.txt",
    "chdir .. & type file",
    "pushd .. && cat file",
    "popd && cat file",
    "Set-Location ..; Get-Content file",
    "sl ..; Get-Content file",
  ]) {
    test(`asks for the whole cwd-changing request: ${command}`, async () => {
      const result = await Effect.runPromise(
        preflight({
          request: request("bash", ["cat file"], {
            command,
            shell: command.startsWith("Set-") || command.startsWith("sl ") ? "powershell" : "cmd",
            parsed: true,
            cwd: process.cwd(),
          }),
          context,
        }),
      )
      expect(result.type).toBe("ask")
    })
  }

  test("asks when parser metadata is missing, invalid, or unusable", async () => {
    for (const metadata of [
      {},
      { command: "git status", shell: "fish", parsed: true, cwd: process.cwd() },
      { command: "git status", shell: "bash", parsed: false, cwd: process.cwd() },
      { command: "git status", shell: "bash", parsed: true, cwd: "relative" },
    ]) {
      expect(
        (await Effect.runPromise(preflight({ request: request("bash", ["git status"], metadata), context }))).type,
      ).toBe("ask")
    }
  })

  test("checks the trusted raw command for omitted sensitive text", async () => {
    const result = await Effect.runPromise(
      preflight({
        request: request("bash", ["git status"], {
          command: "git status # inspect .env.private later",
          shell: "bash",
          parsed: true,
          cwd: process.cwd(),
        }),
        context,
      }),
    )
    expect(result.type).toBe("ask")
  })

  test("keeps external_directory manual", async () => {
    const result = await Effect.runPromise(
      preflight({ request: request("external_directory", ["C:\\outside\\*"]), context }),
    )
    expect(result.type).toBe("ask")
  })

  test("resolves relative targets from metadata cwd and contains them by path semantics", async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "repo")
    const sibling = path.join(tmp.path, "repo-other")
    const nested = path.join(repo, "nested")
    await mkdir(nested, { recursive: true })
    await mkdir(sibling)
    await Bun.write(path.join(nested, "inside.txt"), "inside")
    await Bun.write(path.join(sibling, "outside.txt"), "outside")
    const scopedContext = { ...context, directory: repo }

    expect(
      (
        await Effect.runPromise(
          preflight({
            request: request("bash", ["cat inside.txt"], {
              command: "cat inside.txt",
              shell: "bash",
              parsed: true,
              cwd: nested,
            }),
            context: scopedContext,
          }),
        )
      ).type,
    ).toBe("review")
    expect(
      (
        await Effect.runPromise(
          preflight({
            request: request("bash", ["ls ../../repo-other"], {
              command: "ls ../../repo-other",
              shell: "bash",
              parsed: true,
              cwd: nested,
            }),
            context: scopedContext,
          }),
        )
      ).type,
    ).toBe("ask")
    for (const command of [
      "cat inside.txt ../../repo-other/outside.txt",
      "rg needle ../../repo-other",
      "grep needle ../../repo-other/outside.txt",
      "find ../../repo-other",
      "fd needle ../../repo-other",
      "git diff --no-index inside.txt ../../repo-other/outside.txt",
    ]) {
      expect(
        (
          await Effect.runPromise(
            preflight({
              request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: nested }),
              context: scopedContext,
            }),
          )
        ).type,
      ).toBe("ask")
    }
    expect(
      (
        await Effect.runPromise(
          preflight({
            request: request("bash", ["head -n 10 inside.txt"], {
              command: "head -n 10 inside.txt",
              shell: "bash",
              parsed: true,
              cwd: nested,
            }),
            context: scopedContext,
          }),
        )
      ).type,
    ).toBe("review")
    expect(
      (
        await Effect.runPromise(
          preflight({
            request: request("bash", ["git status"], {
              command: "git status",
              shell: "bash",
              parsed: true,
              cwd: sibling,
            }),
            context: scopedContext,
          }),
        )
      ).type,
    ).toBe("ask")
  })

  test("does not classify find mutation expressions as inspection", async () => {
    for (const command of ["find . -delete", "find . -exec rm {} ;", "find . -ok rm {} ;"]) {
      const result = await Effect.runPromise(
        preflight({
          request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: process.cwd() }),
          context,
        }),
      )
      expect(["ask", "deny"]).toContain(result.type)
    }
  })

  test("asks for a broken symlink instead of trusting its lexical path", async () => {
    await using tmp = await tmpdir()
    const link = path.join(tmp.path, "broken-link")
    await symlink(path.join(tmp.path, "missing-target"), link, process.platform === "win32" ? "junction" : undefined)
    const result = await Effect.runPromise(
      preflight({
        request: request("bash", ["cat broken-link"], {
          command: "cat broken-link",
          shell: "bash",
          parsed: true,
          cwd: tmp.path,
        }),
        context: { ...context, directory: tmp.path },
      }),
    )
    expect(result.type).toBe("ask")
  })

  if (process.platform === "win32") {
    test("normalizes path casing and rejects a different drive", async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "inside.txt"), "inside")
      const caseResult = await Effect.runPromise(
        preflight({
          request: request("bash", ["cat inside.txt"], {
            command: "cat inside.txt",
            shell: "bash",
            parsed: true,
            cwd: tmp.path.toUpperCase(),
          }),
          context: { ...context, directory: tmp.path.toLowerCase() },
        }),
      )
      expect(caseResult.type).toBe("review")

      const otherDrive = path.parse(tmp.path).root.toLowerCase() === "c:\\" ? "E:\\" : "C:\\"
      const driveResult = await Effect.runPromise(
        preflight({
          request: request("bash", [`cat ${otherDrive}outside.txt`], {
            command: `cat ${otherDrive}outside.txt`,
            shell: "bash",
            parsed: true,
            cwd: tmp.path,
          }),
          context: { ...context, directory: tmp.path },
        }),
      )
      expect(driveResult.type).toBe("ask")
    })
  }

  test("fixed reasons do not reflect raw command or path text", async () => {
    const raw = "credential-value-that-must-not-appear"
    const result = await Effect.runPromise(
      preflight({
        request: request("bash", [`cat .env.${raw}`], {
          command: `cat .env.${raw}`,
          shell: "bash",
          parsed: true,
          cwd: process.cwd(),
        }),
        context,
      }),
    )
    expect(JSON.stringify(result)).not.toContain(raw)
  })

  test("scopes validation operands and rejects execution or output options", async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "repo")
    const outside = path.join(tmp.path, "outside")
    await mkdir(repo)
    await mkdir(outside)
    const scopedContext = { ...context, directory: repo }
    const cases = [
      ["bun test ../outside/outside.test.ts", "ask"],
      ["bun test test/unit.test.ts --preload ../outside/evil.ts", "deny"],
      ["go test -o ../outside/testbin ./pkg", "deny"],
      ["go test ./pkg -exec ../outside/wrapper", "deny"],
      ["go test ../outside", "ask"],
      ["cargo check --target-dir ../outside", "deny"],
      ["cargo check --manifest-path ../outside/Cargo.toml", "ask"],
      ["npm run lint -- --output-file ../outside/report.txt", "deny"],
      ["npm run lint -- --unknown-flag", "ask"],
    ] as const
    for (const [command, expected] of cases) {
      const result = await Effect.runPromise(
        preflight({
          request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: repo }),
          context: scopedContext,
        }),
      )
      expect(result.type).toBe(expected)
    }
  })

  test("rejects unverified Git flags and scopes external content operands", async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "repo")
    await mkdir(repo)
    const scopedContext = { ...context, directory: repo }
    const cases = [
      ["git status --unknown-read-flag", "ask"],
      ["git log --output=leak.txt", "deny"],
      ["git show --output ../outside/leak.txt", "deny"],
      ["git stash list --output=leak.txt", "deny"],
      ["git blame --contents ../outside/secret.txt -- tracked.txt", "ask"],
      ["git diff --ext-diff", "ask"],
      ["git show --ext-diff", "ask"],
      ["git cat-file --filters HEAD:file", "ask"],
      ["git diff -- ../outside/secret.txt", "ask"],
    ] as const
    for (const [command, expected] of cases) {
      const result = await Effect.runPromise(
        preflight({
          request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: repo }),
          context: scopedContext,
        }),
      )
      expect(result.type).toBe(expected)
    }
  })

  test("parses find roots and rejects file-writing actions", async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "repo")
    await mkdir(repo)
    const scopedContext = { ...context, directory: repo }
    const cases = [
      ["find -H ../outside -name needle", "ask"],
      ["find . -fprint ../outside/list.txt", "deny"],
      ["find . -fprint0 ../outside/list.txt", "deny"],
      ["find . -fprintf ../outside/list.txt fixed", "deny"],
      ["find . -fls ../outside/list.txt", "deny"],
      ["find . -unknown-action", "ask"],
    ] as const
    for (const [command, expected] of cases) {
      const result = await Effect.runPromise(
        preflight({
          request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: repo }),
          context: scopedContext,
        }),
      )
      expect(result.type).toBe(expected)
    }
  })

  test("keeps home paths, credential caches, and literal tokens out of review and normalization", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    const commands = [
      "cat ~/outside.txt",
      "cat $HOME/outside.txt",
      "Get-Content ~/outside.txt",
      "Get-Content $HOME/outside.txt",
      "cat ~/.azure/msal_http_cache.bin",
      "cat ~/.azure/msal_token_cache.bin",
      "cat ~/.config/gh/hosts.yml",
      `echo ${token}`,
      "echo Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "echo X-API-Key: abcdefghijklmnopqrstuvwxyz0123456789",
    ]
    for (const command of commands) {
      const input = {
        request: request("bash", [command], { command, shell: "bash", parsed: true, cwd: process.cwd() }),
        context,
      }
      const result = await Effect.runPromise(preflight(input))
      expect(result.type).toBe("ask")
      expect(JSON.stringify(result)).not.toContain(token)
    }
    const tokenInput = {
      request: request("bash", [`echo ${token}`], {
        command: `echo ${token}`,
        shell: "bash",
        parsed: true,
        cwd: process.cwd(),
      }),
      context,
    }
    expect(await Effect.runPromise(normalize(tokenInput))).not.toContain(token)
  })
})

test("ruleset digest is canonical and preserves native Plan env patterns", () => {
  const first = [
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
  ] as never
  const second = [
    { action: "ask", pattern: "*.env", permission: "read" },
    { pattern: "*.env.*", permission: "read", action: "ask" },
  ] as never
  expect(rulesetDigest(first)).toBe(rulesetDigest(second))
  expect(rulesetDigest(first)).toBe("7339e9bf2306b355a3490fb5c8633f1755065bba8d8077cae1b9028c6b5d413f")
  expect(rulesetDigest(first)).not.toBe(rulesetDigest([...first].reverse() as never))
})

test("decision matrix permits only the fixed risk combinations", () => {
  expect(decisionAllowed("allow", "low")).toBe(true)
  expect(decisionAllowed("ask", "low")).toBe(true)
  expect(decisionAllowed("deny", "low")).toBe(false)
  expect(decisionAllowed("allow", "medium")).toBe(false)
  expect(decisionAllowed("ask", "medium")).toBe(true)
  expect(decisionAllowed("deny", "medium")).toBe(false)
  expect(decisionAllowed("allow", "high")).toBe(false)
  expect(decisionAllowed("ask", "high")).toBe(true)
  expect(decisionAllowed("deny", "high")).toBe(true)
  expect(decisionAllowed("allow", "critical")).toBe(false)
  expect(decisionAllowed("ask", "critical")).toBe(true)
  expect(decisionAllowed("deny", "critical")).toBe(true)
})

test("normalized request sorts record keys but preserves ordered patterns", async () => {
  const one = await Effect.runPromise(
    normalize({ request: request("bash", ["git status", "git log"], { b: 2, a: { d: 4, c: 3 } }), context }),
  )
  const two = await Effect.runPromise(
    normalize({ request: request("bash", ["git status", "git log"], { a: { c: 3, d: 4 }, b: 2 }), context }),
  )
  const reversed = await Effect.runPromise(
    normalize({ request: request("bash", ["git log", "git status"], { a: { c: 3, d: 4 }, b: 2 }), context }),
  )
  expect(one).toBe(two)
  expect(one).not.toBe(reversed)
})

test("normalized request binds canonical target facts", async () => {
  await using tmp = await tmpdir()
  const first = path.join(tmp.path, "first")
  const second = path.join(tmp.path, "second")
  const link = path.join(tmp.path, "current")
  await mkdir(first)
  await mkdir(second)
  await symlink(first, link, process.platform === "win32" ? "junction" : undefined)
  const input = {
    request: request("bash", ["ls current"], { command: "ls current", shell: "bash", parsed: true, cwd: tmp.path }),
    context: { ...context, directory: tmp.path },
  }
  const before = await Effect.runPromise(normalize(input))
  await unlink(link)
  await symlink(second, link, process.platform === "win32" ? "junction" : undefined)
  const after = await Effect.runPromise(normalize(input))
  expect(before).not.toBe(after)
})
