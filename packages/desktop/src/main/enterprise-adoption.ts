import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

const markerName = "enterprise-legacy-adoption.json"

export async function adoptEnterpriseLegacyState(input: {
  enabled: boolean
  userData: string
  sources: { data: string; config: string; state: string }
}) {
  if (!input.enabled) return { adopted: [] as string[] }
  await mkdir(input.userData, { recursive: true })
  if (await readFile(join(input.userData, markerName)).then(() => true, () => false)) return { adopted: [] as string[] }
  const adopted: string[] = []
  for (const name of ["config", "data", "state"] as const) {
    const source = join(input.sources[name], "opencode")
    const destination = join(input.userData, name, "opencode")
    const exists = await stat(source).then((value) => value.isDirectory(), () => false)
    const destinationExists = await stat(destination).then(() => true, () => false)
    if (!exists || destinationExists) continue
    const temporary = `${destination}.adopting`
    await mkdir(join(input.userData, name), { recursive: true })
    await rm(temporary, { recursive: true, force: true })
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false })
    await rename(temporary, destination)
    adopted.push(name)
  }
  const temporary = join(input.userData, `${markerName}.tmp`)
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, adopted: adopted.sort() }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, join(input.userData, markerName))
  return { adopted }
}
