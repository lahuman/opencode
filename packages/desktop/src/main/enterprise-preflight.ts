import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { EnterpriseProfile } from "../enterprise-profile"
import { verifyEnterpriseSkillPacks } from "./enterprise-skill-packs"

const resourceNames = ["company-guide.md", "models.json", "opencode.jsonc", "skill-packs.json"] as const

type ResourceName = (typeof resourceNames)[number]
export type EnterpriseManifestResources = Record<ResourceName, string>
type EnterpriseManifestProfile = {
  models: { id: string; name: string; baseURL: string }[]
  defaultModelID: string
  defaultsVersion: string
  guideVersion: string
  catalogVersion: string
  allowedOrigins: string[]
}

export type EnterpriseManifestV2 = {
  schemaVersion: 2
  appVersion: string
  defaultsVersion: string
  guideVersion: string
  catalogVersion: string
  defaultModelID: string
  modelIDs: string[]
  modelCatalogSHA256: string
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

export async function createEnterpriseManifest(input: ManifestInput): Promise<EnterpriseManifestV2> {
  const catalog = enterpriseModelCatalogIdentity(input.profile.models)
  if (!catalog.modelIDs.includes(input.profile.defaultModelID)) {
    throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
  }
  return {
    schemaVersion: 2,
    appVersion: requireText(input.appVersion),
    defaultsVersion: requireText(input.profile.defaultsVersion),
    guideVersion: requireText(input.profile.guideVersion),
    catalogVersion: requireText(input.profile.catalogVersion),
    defaultModelID: requireText(input.profile.defaultModelID),
    modelIDs: catalog.modelIDs,
    modelCatalogSHA256: catalog.sha256,
    allowedOrigins: normalizeOrigins(input.profile.allowedOrigins),
    resources: Object.fromEntries(
      await Promise.all(
        resourceNames.map(async (name) => [name, hash(await readFile(input.resources[name]))] as const),
      ),
    ) as Record<ResourceName, string>,
  }
}

export async function writeEnterpriseManifest(path: string, manifest: EnterpriseManifestV2) {
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
      "skill-packs.json": resources[3][1],
    },
  })
  const expected = {
    appVersion: input.appVersion,
    defaultsVersion: input.profile.defaultsVersion,
    guideVersion: input.profile.guideVersion,
    catalogVersion: input.profile.catalogVersion,
    defaultModelID: input.profile.defaultModelID,
    ...enterpriseModelCatalogIdentity(input.profile.models),
    allowedOrigins: normalizeOrigins(input.profile.allowedOrigins),
  }
  if (
    manifest.appVersion !== expected.appVersion ||
    manifest.defaultsVersion !== expected.defaultsVersion ||
    manifest.guideVersion !== expected.guideVersion ||
    manifest.catalogVersion !== expected.catalogVersion ||
    manifest.defaultModelID !== expected.defaultModelID ||
    manifest.modelCatalogSHA256 !== expected.sha256 ||
    manifest.modelIDs.length !== expected.modelIDs.length ||
    manifest.modelIDs.some((modelID, index) => modelID !== expected.modelIDs[index]) ||
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
  return Promise.all([
    verifyEnterpriseManifest({
      manifest: join(input.enterpriseDir, "enterprise-manifest.json"),
      appVersion: input.appVersion,
      profile: {
        models: input.profile.models,
        defaultModelID: input.profile.defaultModelID,
        defaultsVersion: input.profile.defaultsVersion,
        guideVersion: input.profile.guideVersion,
        catalogVersion: input.profile.catalogVersion,
        allowedOrigins: input.profile.allowedOrigins,
      },
      resources: {
        "opencode.jsonc": join(input.enterpriseDir, "opencode.jsonc"),
        "company-guide.md": join(input.enterpriseDir, "company-guide.md"),
        "models.json": join(input.enterpriseDir, "models.json"),
        "skill-packs.json": join(input.enterpriseDir, "skill-packs.json"),
      },
    }),
    verifyEnterpriseSkillPacks(input.enterpriseDir),
  ]).then(([manifest, skillPacks]) => ({ manifest, skillPacks }))
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

function decodeManifest(raw: string): EnterpriseManifestV2 {
  const value: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
    }
  })()
  if (!isRecord(value) || !hasExactKeys(value, [...manifestKeys])) invalidManifest()
  if (value.schemaVersion !== 2) invalidManifest()
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
    !isText(value.defaultModelID) ||
    !Array.isArray(value.modelIDs) ||
    value.modelIDs.some((modelID) => !isText(modelID)) ||
    new Set(value.modelIDs).size !== value.modelIDs.length ||
    !isHash(value.modelCatalogSHA256) ||
    resourceNames.some((name) => typeof resources[name] !== "string" || !/^[a-f0-9]{64}$/.test(resources[name]))
  ) {
    invalidManifest()
  }
  const origins = normalizeOrigins(allowedOrigins)
  if (origins.length !== allowedOrigins.length || origins.some((origin, index) => origin !== allowedOrigins[index])) {
    invalidManifest()
  }
  const modelIDs = value.modelIDs as string[]
  if (
    !modelIDs.includes(value.defaultModelID) ||
    modelIDs.some((modelID, index) => modelID !== [...modelIDs].sort()[index])
  ) {
    invalidManifest()
  }
  return {
    schemaVersion: 2,
    appVersion: value.appVersion,
    defaultsVersion: value.defaultsVersion,
    guideVersion: value.guideVersion,
    catalogVersion: value.catalogVersion,
    defaultModelID: value.defaultModelID,
    modelIDs,
    modelCatalogSHA256: value.modelCatalogSHA256,
    allowedOrigins,
    resources: resources as EnterpriseManifestV2["resources"],
  }
}

const manifestKeys = [
  "allowedOrigins",
  "appVersion",
  "catalogVersion",
  "defaultsVersion",
  "guideVersion",
  "defaultModelID",
  "modelCatalogSHA256",
  "modelIDs",
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

export function enterpriseModelCatalogIdentity(models: { id: string; name: string; baseURL: string }[]) {
  const normalized = models
    .map((model) => ({
      id: requireText(model.id),
      name: requireText(model.name),
      baseURL: requireModelURL(model.baseURL),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const modelIDs = normalized.map((model) => model.id)
  if (!modelIDs.length || new Set(modelIDs).size !== modelIDs.length) {
    throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
  }
  return { modelIDs, sha256: hash(Buffer.from(JSON.stringify(normalized))) }
}

function requireModelURL(value: string) {
  const text = requireText(value)
  const url = (() => {
    try {
      return new URL(text)
    } catch {
      throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
    }
  })()
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    /[?#]/.test(text)
  ) {
    throw new EnterprisePreflightError("manifest_invalid", "Enterprise package manifest is invalid")
  }
  return url.toString()
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
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
