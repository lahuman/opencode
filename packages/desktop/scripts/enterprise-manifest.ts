import type { EnterpriseManifestResources } from "../src/main/enterprise-preflight"
import { createEnterpriseManifest, writeEnterpriseManifest } from "../src/main/enterprise-preflight"
import { validateEnterpriseBuild } from "./enterprise-build"

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
      modelID: profile.modelID,
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
