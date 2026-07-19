import { readdir } from "node:fs/promises"
import path from "node:path"

type Lockfile = { packages?: Record<string, unknown> }

export async function writeEnterpriseSupplyChain(input: {
  archive: string
  appVersion: string
  builtAt: Date
  lockfile?: string
  nodeModules?: string
}) {
  const root = path.resolve(import.meta.dir, "../../..")
  const lockfile: Lockfile = Bun.JSONC.parse(await Bun.file(input.lockfile ?? path.join(root, "bun.lock")).text())
  const dependencies = Object.values(lockfile.packages ?? {})
    .flatMap((entry) => {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") return []
      const separator = entry[0].lastIndexOf("@")
      if (separator <= 0) return []
      const name = entry[0].slice(0, separator)
      const version = entry[0].slice(separator + 1)
      if (!name || !version || name.includes("..")) return []
      return [{ name, version }]
    })
    .filter((dependency, index, all) => all.findIndex((item) => item.name === dependency.name && item.version === dependency.version) === index)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const modules = input.nodeModules ?? path.join(root, "node_modules")
  const notices = await Promise.all(
    dependencies.map(async (dependency) => {
      const directory = path.join(modules, ...dependency.name.split("/"))
      const metadata = await Bun.file(path.join(directory, "package.json"))
        .json<{ license?: unknown }>()
        .catch(() => undefined)
      const license = typeof metadata?.license === "string" ? metadata.license : "NOASSERTION"
      const names = await readdir(directory).catch(() => [])
      const files = names.filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort()
      const texts = await Promise.all(
        files.map((name) =>
          Bun.file(path.join(directory, name))
            .text()
            .catch(() => ""),
        ),
      )
      return {
        ...dependency,
        license,
        text: texts.filter(Boolean).join("\n\n"),
      }
    }),
  )
  const sbom = input.archive.replace(/\.zip$/, ".sbom.cdx.json")
  const licenses = input.archive.replace(/\.zip$/, ".third-party-licenses.txt")
  await Bun.write(
    sbom,
    `${JSON.stringify(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
          timestamp: input.builtAt.toISOString(),
          component: { type: "application", name: "kernexa", version: input.appVersion },
        },
        components: notices.map((dependency) => {
          const purl = `pkg:npm/${dependency.name.startsWith("@") ? `%40${dependency.name.slice(1)}` : dependency.name}@${dependency.version}`
          return {
            type: "library",
            "bom-ref": purl,
            name: dependency.name,
            version: dependency.version,
            purl,
            ...(dependency.license === "NOASSERTION" ? {} : { licenses: [{ expression: dependency.license }] }),
          }
        }),
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(
    licenses,
    `Kernexa third-party licenses\nGenerated: ${input.builtAt.toISOString()}\n\n${notices
      .map(
        (dependency) =>
          `${dependency.name}@${dependency.version}\nDeclared license: ${dependency.license}\n${dependency.text || "License text unavailable in the local dependency installation."}`,
      )
      .join("\n\n---\n\n")}\n`,
  )
  return { sbom, licenses }
}
