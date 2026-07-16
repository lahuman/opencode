import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  createEnterpriseManifest,
  EnterprisePreflightError,
  runEnterprisePreflight,
  verifyEnterpriseManifest,
  writeEnterpriseManifest,
} from "./enterprise-preflight"

const profile = {
  modelID: "company-code",
  defaultsVersion: "defaults-2",
  guideVersion: "guide-3",
  catalogVersion: "catalog-4",
  allowedOrigins: ["https://llm.corp.example", "https://llm-dr.corp.example"],
}

test("creates and verifies a deterministic non-secret enterprise manifest", async () => {
  await using fixture = await enterpriseFixture()
  const manifest = await createEnterpriseManifest({
    appVersion: "1.2.3",
    profile,
    resources: fixture.resources,
  })

  expect(manifest).toEqual({
    schemaVersion: 1,
    appVersion: "1.2.3",
    defaultsVersion: "defaults-2",
    guideVersion: "guide-3",
    catalogVersion: "catalog-4",
    modelID: "company-code",
    allowedOrigins: ["https://llm-dr.corp.example", "https://llm.corp.example"],
    resources: {
      "company-guide.md": expect.stringMatching(/^[a-f0-9]{64}$/),
      "models.json": expect.stringMatching(/^[a-f0-9]{64}$/),
      "opencode.jsonc": expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  })
  expect(JSON.stringify(manifest)).not.toContain("/v1")
  expect(JSON.stringify(manifest)).not.toContain("Company Code")
  expect(JSON.stringify(manifest)).not.toContain("secret-marker")

  await writeEnterpriseManifest(fixture.manifest, manifest)
  expect(
    await verifyEnterpriseManifest({
      manifest: fixture.manifest,
      appVersion: "1.2.3",
      profile,
      resources: fixture.resources,
    }),
  ).toEqual(manifest)
})

test("fails closed when an enterprise resource changes after manifest creation", async () => {
  await using fixture = await enterpriseFixture()
  await writeEnterpriseManifest(
    fixture.manifest,
    await createEnterpriseManifest({ appVersion: "1.2.3", profile, resources: fixture.resources }),
  )
  await Bun.write(fixture.resources["company-guide.md"], "tampered secret-marker")

  const error = await verifyFailure({
    manifest: fixture.manifest,
    appVersion: "1.2.3",
    profile,
    resources: fixture.resources,
  })
  expect(error.kind).toBe("resource_mismatch")
  expect(error.message).toBe("Enterprise package resource verification failed")
  expect(error.message).not.toContain("secret-marker")
})

test("rejects invalid manifests and packaged profile mismatches with fixed errors", async () => {
  await using fixture = await enterpriseFixture()
  await Bun.write(fixture.manifest, "{ invalid secret-marker")
  const invalid = await verifyFailure({
    manifest: fixture.manifest,
    appVersion: "1.2.3",
    profile,
    resources: fixture.resources,
  })
  expect(invalid.kind).toBe("manifest_invalid")
  expect(invalid.message).not.toContain("secret-marker")

  await writeEnterpriseManifest(
    fixture.manifest,
    await createEnterpriseManifest({ appVersion: "1.2.3", profile, resources: fixture.resources }),
  )
  const mismatch = await verifyFailure({
    manifest: fixture.manifest,
    appVersion: "1.2.4",
    profile,
    resources: fixture.resources,
  })
  expect(mismatch.kind).toBe("profile_mismatch")
  expect(mismatch.message).toBe("Enterprise package profile verification failed")
})

test("reports a missing manifest without exposing its filesystem path", async () => {
  await using fixture = await enterpriseFixture()
  const missing = join(fixture.root, "private-secret-marker", "enterprise-manifest.json")
  const error = await verifyFailure({
    manifest: missing,
    appVersion: "1.2.3",
    profile,
    resources: fixture.resources,
  })
  expect(error.kind).toBe("manifest_missing")
  expect(error.message).toBe("Enterprise package manifest is missing")
  expect(error.message).not.toContain("private-secret-marker")
})

test("skips ordinary builds and verifies enabled packaged profiles", async () => {
  await using fixture = await enterpriseFixture()
  expect(
    await runEnterprisePreflight({
      profile: { enabled: false },
      appVersion: "1.2.3",
      enterpriseDir: join(fixture.root, "missing"),
    }),
  ).toBeUndefined()

  await writeEnterpriseManifest(
    fixture.manifest,
    await createEnterpriseManifest({
      appVersion: "1.2.3",
      profile,
      resources: fixture.resources,
    }),
  )
  expect(
    await runEnterprisePreflight({
      profile: {
        enabled: true,
        baseURL: "https://llm.corp.example/v1",
        modelID: profile.modelID,
        modelName: "Company Code",
        defaultsVersion: profile.defaultsVersion,
        guideVersion: profile.guideVersion,
        catalogVersion: profile.catalogVersion,
        allowedOrigins: profile.allowedOrigins,
      },
      appVersion: "1.2.3",
      enterpriseDir: fixture.root,
    }),
  ).toMatchObject({ schemaVersion: 1, catalogVersion: profile.catalogVersion })
})

async function enterpriseFixture() {
  const root = await mkdtemp(join(tmpdir(), "enterprise-preflight-"))
  const resources = {
    "opencode.jsonc": join(root, "opencode.jsonc"),
    "company-guide.md": join(root, "company-guide.md"),
    "models.json": join(root, "models.json"),
  }
  await Promise.all([
    Bun.write(resources["opencode.jsonc"], '{"provider":"company-llm","marker":"secret-marker"}'),
    Bun.write(resources["company-guide.md"], "# Company guide"),
    Bun.write(resources["models.json"], "{}"),
  ])
  return {
    root,
    resources,
    manifest: join(root, "enterprise-manifest.json"),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

async function verifyFailure(input: Parameters<typeof verifyEnterpriseManifest>[0]) {
  try {
    await verifyEnterpriseManifest(input)
  } catch (error) {
    if (error instanceof EnterprisePreflightError) return error
    throw error
  }
  throw new Error("Expected enterprise preflight to fail")
}
