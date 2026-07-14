import { readFile } from "node:fs/promises"

type EnterpriseGuideConfig = {
  enabled: boolean
  path: string
  version: string
}

export async function readEnterpriseGuide(input: EnterpriseGuideConfig) {
  if (!input.enabled) throw new Error("Company guide is unavailable")
  const markdown = await readFile(input.path, "utf8").catch(() => undefined)
  if (markdown === undefined) throw new Error("Company guide could not be read")
  return {
    version: input.version,
    markdown,
  }
}

export function registerEnterpriseGuideIpc(
  register: (channel: string, handler: () => unknown) => void,
  guide: EnterpriseGuideConfig,
) {
  register("enterprise-guide-read", () => readEnterpriseGuide(guide))
}
