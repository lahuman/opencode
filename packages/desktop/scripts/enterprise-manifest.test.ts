import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { generateEnterpriseManifest, prepareEnterpriseManifest } from "./enterprise-manifest"

test("keeps the generated Kernexa guide and manifest version aligned", async () => {
  const root = resolve(import.meta.dir, "..")
  const guide = Bun.file(join(root, "resources/enterprise/company-guide.md"))
  const manifest = await Bun.file(join(root, "resources/enterprise/enterprise-manifest.json")).json<{
    guideVersion: string
    resources: Record<string, string>
  }>()

  expect(manifest.guideVersion).toBe("kernexa-1")
  expect(await guide.text()).toStartWith("# Kernexa AI 사용 가이드\n")
  expect(manifest.resources["company-guide.md"]).toBe(
    new Bun.CryptoHasher("sha256").update(await guide.arrayBuffer()).digest("hex"),
  )
})

test("generates the packaged manifest from validated enterprise build inputs", async () => {
  await using fixture = await manifestFixture()
  const manifest = await generateEnterpriseManifest({
    appVersion: "1.2.3",
    output: fixture.output,
    resources: fixture.resources,
    env: {
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
        { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
        { id: "company-fast", name: "Company Fast", baseURL: "https://fast.corp.example/v1" },
      ]),
      OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "defaults-2",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "guide-3",
      OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-4",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
      OPENCODE_ENTERPRISE_SECRET_HEADERS: "secret-marker",
    },
  })

  expect(manifest.catalogVersion).toBe("catalog-4")
  expect(manifest.allowedOrigins).toEqual(["https://fast.corp.example", "https://llm.corp.example"])
  expect(await Bun.file(fixture.output).json()).toEqual(manifest)
  expect(await Bun.file(fixture.output).text()).not.toContain("secret-marker")
  expect(await Bun.file(fixture.output).text()).not.toContain("/v1")
})

test("prepares a manifest only for enterprise builds", async () => {
  await using fixture = await manifestFixture()
  expect(
    await prepareEnterpriseManifest({
      appVersion: "1.2.3",
      env: {},
      output: fixture.output,
      resources: fixture.resources,
    }),
  ).toBeUndefined()
  expect(await Bun.file(fixture.output).exists()).toBeFalse()

  expect(
    await prepareEnterpriseManifest({
      appVersion: "1.2.3",
      output: fixture.output,
      resources: fixture.resources,
      env: {
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
          { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
        ]),
        OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "defaults-2",
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "guide-3",
        OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-4",
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
      },
    }),
  ).toMatchObject({ schemaVersion: 2, appVersion: "1.2.3" })
})

async function manifestFixture() {
  const root = await mkdtemp(join(tmpdir(), "enterprise-manifest-build-"))
  const resources = {
    "opencode.jsonc": join(root, "opencode.jsonc"),
    "company-guide.md": join(root, "company-guide.md"),
    "models.json": join(root, "models.json"),
    "skill-packs.json": join(root, "skill-packs.json"),
  }
  await Promise.all([
    Bun.write(resources["opencode.jsonc"], "{}"),
    Bun.write(resources["company-guide.md"], "# Guide"),
    Bun.write(resources["models.json"], "{}"),
    Bun.write(resources["skill-packs.json"], '{"schemaVersion":1,"packs":[]}'),
  ])
  return {
    resources,
    output: join(root, "enterprise-manifest.json"),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}
