import { expect, test } from "bun:test"
import path from "node:path"

import { runEnterpriseDev } from "./dev-enterprise"
import type { generateEnterpriseManifest } from "./enterprise-manifest"

type ManifestInput = Parameters<typeof generateEnterpriseManifest>[0]

const valid = {
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "dev-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "dev-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
}

test("validates, prepares the enterprise manifest, and starts desktop development in enterprise mode", async () => {
  const events: string[] = []
  const preparations: ManifestInput[] = []
  const calls: { command: string[]; env: Record<string, string | undefined> }[] = []
  const code = await runEnterpriseDev({
    env: valid,
    async prepare(input: ManifestInput) {
      preparations.push(input)
      await Promise.resolve()
      events.push("prepare")
    },
    spawn(command, options) {
      events.push("spawn")
      calls.push({ command, env: options.env })
      return { exited: Promise.resolve(0) }
    },
  })

  expect(code).toBe(0)
  expect(events).toEqual(["prepare", "spawn"])
  expect(preparations).toEqual([
    {
      appVersion: (await Bun.file(path.resolve(import.meta.dir, "../package.json")).json<{ version: string }>())
        .version,
      env: { ...valid, OPENCODE_ENTERPRISE: "1" },
      output: path.resolve(import.meta.dir, "../resources/enterprise/enterprise-manifest.json"),
      resources: {
        "opencode.jsonc": path.resolve(import.meta.dir, "../resources/enterprise/opencode.jsonc"),
        "company-guide.md": path.resolve(import.meta.dir, "../resources/enterprise/company-guide.md"),
        "models.json": path.resolve(import.meta.dir, "../resources/enterprise/models.json"),
      },
    },
  ])
  expect(calls).toEqual([
    {
      command: ["bun", "run", "dev"],
      env: { ...valid, OPENCODE_ENTERPRISE: "1" },
    },
  ])
})

test("does not start desktop development when the enterprise profile is incomplete", async () => {
  let prepared = false
  let spawned = false

  await expect(
    runEnterpriseDev({
      env: {},
      async prepare() {
        prepared = true
      },
      spawn() {
        spawned = true
        return { exited: Promise.resolve(0) }
      },
    }),
  ).rejects.toThrow("OPENCODE_ENTERPRISE_BASE_URL")
  expect(prepared).toBe(false)
  expect(spawned).toBe(false)
})

test("propagates manifest preparation failures without starting desktop development", async () => {
  const failure = new Error("manifest preparation failed")
  let spawned = false

  await expect(
    runEnterpriseDev({
      env: valid,
      async prepare() {
        throw failure
      },
      spawn() {
        spawned = true
        return { exited: Promise.resolve(0) }
      },
    }),
  ).rejects.toBe(failure)
  expect(spawned).toBe(false)
})
