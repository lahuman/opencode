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
    const state = { spawns: 0, stages: 0 }

    await expect(
      runEnterpriseWindowsPackage({
        ...host,
        env: valid,
        stage() {
          state.stages++
          return Promise.resolve({ cleanup: () => Promise.resolve() })
        },
        spawn() {
          state.spawns++
          return { exited: Promise.resolve(0) }
        },
      }),
    ).rejects.toThrow("Windows x64")
    expect(state.spawns).toBe(0)
    expect(state.stages).toBe(0)
  }
})

test("validates enterprise inputs before spawning", async () => {
  const state = { spawns: 0, stages: 0 }

  await expect(
    runEnterpriseWindowsPackage({
      platform: "win32",
      arch: "x64",
      env: { ...valid, CSC_LINK: undefined },
      stage() {
        state.stages++
        return Promise.resolve({ cleanup: () => Promise.resolve() })
      },
      spawn() {
        state.spawns++
        return { exited: Promise.resolve(0) }
      },
    }),
  ).rejects.toThrow("CSC_LINK")
  expect(state.spawns).toBe(0)
  expect(state.stages).toBe(0)
})

test("stages before build then runs both commands with opaque inherited environment and cleanup", async () => {
  const commands: string[][] = []
  const events: string[] = []
  const env = { ...valid }

  const code = await runEnterpriseWindowsPackage({
    platform: "win32",
    arch: "x64",
    env,
    stage(value) {
      events.push("stage")
      value.CSC_LINK = "C:/opaque/certificate.pfx"
      return Promise.resolve({
        cleanup() {
          events.push("cleanup")
          return Promise.resolve()
        },
      })
    },
    spawn(command, options) {
      commands.push(command)
      events.push(command[2] ?? "unknown")
      expect(options).toEqual({
        cwd: path.resolve(import.meta.dir, ".."),
        env,
        stdout: "inherit",
        stderr: "inherit",
      })
      expect(options.env.CSC_LINK).toBe("C:/opaque/certificate.pfx")
      return { exited: Promise.resolve(0) }
    },
  })

  expect(code).toBe(0)
  expect(commands).toEqual([
    ["bun", "run", "build"],
    ["bun", "run", "package:win", "--x64"],
  ])
  expect(events).toEqual(["stage", "build", "package:win", "cleanup"])
})

test("returns the first nonzero exit code without spawning the package command and cleans up", async () => {
  const commands: string[][] = []
  const events: string[] = []

  const code = await runEnterpriseWindowsPackage({
    platform: "win32",
    arch: "x64",
    env: { ...valid },
    stage() {
      events.push("stage")
      return Promise.resolve({
        cleanup() {
          events.push("cleanup")
          return Promise.resolve()
        },
      })
    },
    spawn(command) {
      commands.push(command)
      events.push(command[2] ?? "unknown")
      return { exited: Promise.resolve(commands.length === 1 ? 17 : 0) }
    },
  })

  expect(code).toBe(17)
  expect(commands).toEqual([["bun", "run", "build"]])
  expect(events).toEqual(["stage", "build", "cleanup"])
})

test("returns the package exit code after a successful build and cleans up", async () => {
  const commands: string[][] = []
  const events: string[] = []

  const code = await runEnterpriseWindowsPackage({
    platform: "win32",
    arch: "x64",
    env: { ...valid },
    stage() {
      events.push("stage")
      return Promise.resolve({
        cleanup() {
          events.push("cleanup")
          return Promise.resolve()
        },
      })
    },
    spawn(command) {
      commands.push(command)
      events.push(command[2] ?? "unknown")
      return { exited: Promise.resolve(commands.length === 1 ? 0 : 23) }
    },
  })

  expect(code).toBe(23)
  expect(commands).toEqual([
    ["bun", "run", "build"],
    ["bun", "run", "package:win", "--x64"],
  ])
  expect(events).toEqual(["stage", "build", "package:win", "cleanup"])
})

test("exposes the exact Bun TypeScript enterprise package script", async () => {
  const pkg = await Bun.file(path.resolve(import.meta.dir, "../package.json")).json()
  expect(pkg.scripts["package:enterprise:win"]).toBe("bun ./scripts/package-enterprise-win.ts")
})
