import { expect, test } from "bun:test"
import path from "node:path"

import { runEnterpriseWindowsPackage } from "./package-enterprise-win"

const valid = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
  CSC_LINK: "set",
  CSC_KEY_PASSWORD: "set",
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
      env: { ...valid, CSC_LINK: undefined },
      spawn() {
        state.spawns++
        return { exited: Promise.resolve(0) }
      },
    }),
  ).rejects.toThrow("CSC_LINK")
  expect(state.spawns).toBe(0)
})

test("runs build then Windows x64 packaging with inherited output and environment", async () => {
  const commands: string[][] = []

  const code = await runEnterpriseWindowsPackage({
    platform: "win32",
    arch: "x64",
    env: valid,
    spawn(command, options) {
      commands.push(command)
      expect(options).toEqual({
        cwd: path.resolve(import.meta.dir, ".."),
        env: valid,
        stdout: "inherit",
        stderr: "inherit",
      })
      return { exited: Promise.resolve(0) }
    },
  })

  expect(code).toBe(0)
  expect(commands).toEqual([
    ["bun", "run", "build"],
    ["bun", "run", "package:win", "--x64"],
  ])
})

test("returns the first nonzero exit code without spawning the package command", async () => {
  const commands: string[][] = []

  const code = await runEnterpriseWindowsPackage({
    platform: "win32",
    arch: "x64",
    env: valid,
    spawn(command) {
      commands.push(command)
      return { exited: Promise.resolve(commands.length === 1 ? 17 : 0) }
    },
  })

  expect(code).toBe(17)
  expect(commands).toEqual([["bun", "run", "build"]])
})

test("exposes the exact Bun TypeScript enterprise package script", async () => {
  const pkg = await Bun.file(path.resolve(import.meta.dir, "../package.json")).json()
  expect(pkg.scripts["package:enterprise:win"]).toBe("bun ./scripts/package-enterprise-win.ts")
})
