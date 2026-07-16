import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { EnterpriseProfile } from "../enterprise-profile"

const resourceNames = ["company-guide.md", "models.json", "opencode.jsonc"] as const

type ResourceName = (typeof resourceNames)[number]
export type EnterpriseManifestResources = Record<ResourceName, string>
type EnterpriseManifestProfile = {
  modelID: string
  defaultsVersion: string
  guideVersion: string
  catalogVersion: string
  allowedOrigins: string[]
}

export type EnterpriseManifestV1 = {
  schemaVersion: 1
  appVersion: string
  defaultsVersion: string
  guideVersion: string
  catalogVersion: string
  modelID: string
  allowedOrigins: string[]
  resources: Record<ResourceName, string>
}

type ManifestInput = {
  appVersion: string
  profile: EnterpriseManifestProfile
  resources: EnterpriseManifestResources
}

export type EnterprisePreflightFailure =
  | "manifest_missing"
  | "manifest_invalid"
  | "profile_mismatch"
  | "resource_missing"
  | "resource_mismatch"

export class EnterprisePreflightError extends Error {
  constructor(
    readonly kind: EnterprisePreflightFailure,
    message: string,
  ) {
    super(message)
    this.name = "EnterprisePreflightError"
  }
}

export async function createEnterpriseManifest(input: ManifestInput): Promise<EnterpriseManifestV1> {
  return {
    schemaVersion: 1,
    appVersion: requireText(input.appVersion),
    defaultsVersion: requireText(input.profile.defaultsVersion),
    guideVersion: requireText(input.profile.guideVersion),
    catalogVersion: requireText(input.profile.catalogVersion),
    modelID: requireText(input.profile.modelID),
    allowedOrigins: normalizeOrigins(input.profile.allowedOrigins),
    resources: Object.fromEntries(
      await Promise.all(
        resourceNames.map(async (name) => [name, hash(await readFile(input.resources[name]))] as const),
      ),
    ) as Record<ResourceName, string>,
  }
}

export async function writeEnterpriseManifest(path: string, manifest: EnterpriseManifestV1) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function verifyEnterpriseManifest(input: ManifestInput & { manifest: string }) {
  const raw = await readFile(input.manifest, "utf8").catch((error: unknown) => {
    if (isMissing(error)) {
      throw new EnterprisePreflightError("manifest_missing", "Enterprise package manifest is missing")
    }
    throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest could not be read")
  })
  const resources = await Promise.all(
    resourceNames.map(async (name) => {
      const bytes = await readFile(input.resources[name]).catch((error: unknown) => {
        if (isMissing(error)) {
          throw new EnterprisePreflightError("resource_missing", "Enterprise package resource is missing")
        }
        throw new EnterprisePreflightError("resource_mismatch", "Enterprise package resource verification failed")
      })
      return [name, bytes] as const
    }),
  )
  const manifest = verifyEnterpriseManifestContents({
    manifest: raw,
    resources: {
      "company-guide.md": resources[0][1],
      "models.json": resources[1][1],
      "opencode.jsonc": resources[2][1],
    },
  })
  const expected = {
    appVersion: input.appVersion,
    defaultsVersion: input.profile.defaultsVersion,
    guideVersion: input.profile.guideVersion,
    catalogVersion: input.profile.catalogVersion,
    modelID: input.profile.modelID,
    allowedOrigins: normalizeOrigins(input.profile.allowedOrigins),
  }
  if (
    manifest.appVersion !== expected.appVersion ||
    manifest.defaultsVersion !== expected.defaultsVersion ||
    manifest.guideVersion !== expected.guideVersion ||
    manifest.catalogVersion !== expected.catalogVersion ||
    manifest.modelID !== expected.modelID ||
    manifest.allowedOrigins.length !== expected.allowedOrigins.length ||
    manifest.allowedOrigins.some((origin, index) => origin !== expected.allowedOrigins[index])
  ) {
    throw new EnterprisePreflightError("profile_mismatch", "Enterprise package profile verification failed")
  }

  return manifest
}

export function runEnterprisePreflight(input: {
  profile: EnterpriseProfile
  appVersion: string
  enterpriseDir: string
}) {
  if (!input.profile.enabled) return Promise.resolve(undefined)
  return verifyEnterpriseManifest({
    manifest: join(input.enterpriseDir, "enterprise-manifest.json"),
    appVersion: input.appVersion,
    profile: {
      modelID: input.profile.modelID,
      defaultsVersion: input.profile.defaultsVersion,
      guideVersion: input.profile.guideVersion,
      catalogVersion: input.profile.catalogVersion,
      allowedOrigins: input.profile.allowedOrigins,
    },
    resources: {
      "opencode.jsonc": join(input.enterpriseDir, "opencode.jsonc"),
      "company-guide.md": join(input.enterpriseDir, "company-guide.md"),
      "models.json": join(input.enterpriseDir, "models.json"),
    },
  })
}

export function verifyEnterpriseManifestContents(input: {
  manifest: string
  resources: Record<ResourceName, Uint8Array>
}) {
  const manifest = decodeManifest(input.manifest)
  if (resourceNames.some((name) => hash(input.resources[name]) !== manifest.resources[name])) {
    throw new EnterprisePreflightError("resource_mismatch", "Enterprise package resource verification failed")
  }
  return manifest
}

function decodeManifest(raw: string): EnterpriseManifestV1 {
  const value: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
    }
  })()
  if (!isRecord(value) || !hasExactKeys(value, [...manifestKeys])) invalidManifest()
  if (value.schemaVersion !== 1) invalidManifest()
  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.some((origin) => typeof origin !== "string"))
    invalidManifest()
  const allowedOrigins = value.allowedOrigins as string[]
  if (!isRecord(value.resources) || !hasExactKeys(value.resources, [...resourceNames])) invalidManifest()
  const resources = value.resources
  if (
    !isText(value.appVersion) ||
    !isText(value.defaultsVersion) ||
    !isText(value.guideVersion) ||
    !isText(value.catalogVersion) ||
    !isText(value.modelID) ||
    resourceNames.some((name) => typeof resources[name] !== "string" || !/^[a-f0-9]{64}$/.test(resources[name]))
  ) {
    invalidManifest()
  }
  const origins = normalizeOrigins(allowedOrigins)
  if (origins.length !== allowedOrigins.length || origins.some((origin, index) => origin !== allowedOrigins[index])) {
    invalidManifest()
  }
  return {
    schemaVersion: 1,
    appVersion: value.appVersion,
    defaultsVersion: value.defaultsVersion,
    guideVersion: value.guideVersion,
    catalogVersion: value.catalogVersion,
    modelID: value.modelID,
    allowedOrigins,
    resources: resources as EnterpriseManifestV1["resources"],
  }
}

const manifestKeys = [
  "allowedOrigins",
  "appVersion",
  "catalogVersion",
  "defaultsVersion",
  "guideVersion",
  "modelID",
  "resources",
  "schemaVersion",
] as const

function normalizeOrigins(origins: string[]) {
  const normalized = origins.map((value) => {
    const url = new URL(value)
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.href !== `${url.origin}/`
    ) {
      throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
    }
    return url.origin
  })
  return Array.from(new Set(normalized)).sort()
}

function requireText(value: string) {
  if (!isText(value)) throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
  return value
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
}

function hash(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  const expected = keys.sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function invalidManifest(): never {
  throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
