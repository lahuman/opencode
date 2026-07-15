import { expect, test } from "bun:test"
import path from "node:path"

import { validateEnterpriseBuild } from "./enterprise-build"
import { runEnterpriseWindowsPackage } from "./package-enterprise-win"

const valid = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
}

test("rejects non-Windows and non-x64 hosts before spawning", async () => {
  for (const host of [
    { platform: "darwin", arch: "x64" },
    { platform: "win32", arch: "arm64" },
  ]) {
    const state = { spawns: 0 }

    await expect(
      runEnterpriseWindowsPackage({
        ...host,
        env: valid,
        spawn() {
          state.spawns++
          return { exited: Promise.resolve(0) }
        },
      }),
    ).rejects.toThrow("Windows x64")
    expect(state.spawns).toBe(0)
  }
})

test("validates enterprise inputs before spawning", async () => {
  const state = { spawns: 0 }

  await expect(
    runEnterpriseWindowsPackage({
      platform: "win32",
      arch: "x64",
      env: { ...valid, OPENCODE_ENTERPRISE_BASE_URL: undefined },
      spawn() {
        state.spawns++
        return { exited: Promise.resolve(0) }
      },
    }),
  ).rejects.toThrow("OPENCODE_ENTERPRISE_BASE_URL")
  expect(state.spawns).toBe(0)
})

test("runs validation, build, package, verification, git, and release in order", async () => {
  const steps: string[] = []
  const env = {
    ...valid,
    CSC_LINK: "csc-link-secret-marker",
    CSC_KEY_PASSWORD: "csc-password-secret-marker",
    WIN_CSC_LINK: "win-csc-link-secret-marker",
    cSc_Mixed_Case: "mixed-case-secret-marker",
    PATH: "preserve-me",
  }

  const code = await runEnterpriseWindowsPackage({
    platform: "win32",
    arch: "x64",
    env,
    version: "1.17.18",
    validate(value) {
      steps.push("validate")
      return validateEnterpriseBuild(value)
    },
    spawn(command, options) {
      steps.push(command[2] ?? command[1])
      expect(options).toEqual({
        cwd: path.resolve(import.meta.dir, ".."),
        env: expect.any(Object),
        stdout: "inherit",
        stderr: "inherit",
      })
      expect(options.env.PATH).toBe("preserve-me")
      expect(
        Object.keys(options.env).filter((key) => {
          const upper = key.toUpperCase()
          return upper.startsWith("CSC_") || upper.startsWith("WIN_CSC_")
        }),
      ).toEqual([])
      return { exited: Promise.resolve(0) }
    },
    verifyPackage(root) {
      steps.push("verify-unpacked")
      expect(root).toBe(path.resolve(import.meta.dir, "../dist/win-unpacked"))
      return Promise.resolve({})
    },
    verifyArchive(archive, root) {
      steps.push("verify-zip")
      expect(archive).toBe(path.resolve(import.meta.dir, "../dist/company-opencode-pilot-1.17.18-win-x64.zip"))
      expect(root).toBe(path.resolve(import.meta.dir, "../dist/win-unpacked"))
      return Promise.resolve([])
    },
    gitCommit() {
      steps.push("git-commit")
      return Promise.resolve("0123456789abcdef")
    },
    release(input) {
      steps.push("release")
      expect(input).toMatchObject({
        archive: path.resolve(import.meta.dir, "../dist/company-opencode-pilot-1.17.18-win-x64.zip"),
        version: "1.17.18",
        gitCommit: "0123456789abcdef",
      })
      return Promise.resolve({})
    },
  })

  expect(code).toBe(0)
  expect(steps).toEqual(["validate", "build", "package:win", "verify-unpacked", "verify-zip", "git-commit", "release"])
})

test("returns the first nonzero exit code without spawning the package command", async () => {
  const commands: string[][] = []

  const code = await runEnterpriseWindowsPackage({
    platform: "win32",
    arch: "x64",
    env: { ...valid },
    spawn(command) {
      commands.push(command)
      return { exited: Promise.resolve(commands.length === 1 ? 17 : 0) }
    },
  })

  expect(code).toBe(17)
  expect(commands).toEqual([["bun", "run", "build"]])
})

test("returns the package exit code after a successful build", async () => {
  const commands: string[][] = []

  const code = await runEnterpriseWindowsPackage({
    platform: "win32",
    arch: "x64",
    env: { ...valid },
    spawn(command) {
      commands.push(command)
      return { exited: Promise.resolve(commands.length === 1 ? 0 : 23) }
    },
  })

  expect(code).toBe(23)
  expect(commands).toEqual([
    ["bun", "run", "build"],
    ["bun", "run", "package:win", "--x64"],
  ])
})

test("stops after an unpacked-package verification failure", async () => {
  const steps: string[] = []

  await expect(
    runEnterpriseWindowsPackage({
      platform: "win32",
      arch: "x64",
      env: valid,
      version: "1.17.18",
      spawn(command) {
        steps.push(command[2] ?? command[1])
        return { exited: Promise.resolve(0) }
      },
      verifyPackage() {
        steps.push("verify-unpacked")
        return Promise.reject(new Error("Portable package is invalid"))
      },
      verifyArchive() {
        steps.push("verify-zip")
        return Promise.resolve([])
      },
      gitCommit() {
        steps.push("git-commit")
        return Promise.resolve("0123456789abcdef")
      },
      release() {
        steps.push("release")
        return Promise.resolve({})
      },
    }),
  ).rejects.toThrow("Portable package")
  expect(steps).toEqual(["build", "package:win", "verify-unpacked"])
})

test("exposes the exact Bun TypeScript enterprise package script", async () => {
  const pkg = await Bun.file(path.resolve(import.meta.dir, "../package.json")).json()
  expect(pkg.scripts["package:enterprise:win"]).toBe("bun ./scripts/package-enterprise-win.ts")
  expect(pkg.scripts["verify:enterprise:package"]).toBe(
    "bun ./scripts/verify-enterprise-package.ts ./dist/win-unpacked",
  )
})
