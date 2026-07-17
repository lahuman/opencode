import type { EnterpriseManifestResources } from "../src/main/enterprise-preflight"
import { createEnterpriseManifest, writeEnterpriseManifest } from "../src/main/enterprise-preflight"
import { validateEnterpriseBuild } from "./enterprise-build"
import path from "node:path"

type Env = Record<string, string | undefined>

export async function generateEnterpriseManifest(input: {
  appVersion: string
  env: Env
  output: string
  resources: EnterpriseManifestResources
}) {
  const profile = validateEnterpriseBuild(input.env)
  const manifest = await createEnterpriseManifest({
    appVersion: input.appVersion,
    profile: {
      models: profile.models,
      defaultModelID: profile.defaultModelID,
      defaultsVersion: profile.defaultsVersion,
      guideVersion: profile.guideVersion,
      catalogVersion: profile.catalogVersion,
      allowedOrigins: profile.allowedOrigins,
    },
    resources: input.resources,
  })
  await writeEnterpriseManifest(input.output, manifest)
  return manifest
}

export async function prepareEnterpriseManifest(input: Parameters<typeof generateEnterpriseManifest>[0]) {
  if (input.env.OPENCODE_ENTERPRISE !== "1") return
  return generateEnterpriseManifest(input)
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..")
  await generateEnterpriseManifest({
    appVersion: (await Bun.file(path.join(root, "package.json")).json<{ version: string }>()).version,
    env: { ...process.env, OPENCODE_ENTERPRISE: "1" },
    output: path.join(root, "resources", "enterprise", "enterprise-manifest.json"),
    resources: {
      "opencode.jsonc": path.join(root, "resources", "enterprise", "opencode.jsonc"),
      "company-guide.md": path.join(root, "resources", "enterprise", "company-guide.md"),
      "models.json": path.join(root, "resources", "enterprise", "models.json"),
      "skill-packs.json": path.join(root, "resources", "enterprise", "skill-packs.json"),
    },
  })
}
