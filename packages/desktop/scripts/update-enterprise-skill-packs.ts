import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { skillPackTreeHash } from "../src/main/enterprise-skill-packs"

const sources = [
  {
    id: "ponytail",
    displayName: "Ponytail",
    description: "Prefer existing helpers, platform features, and installed dependencies before adding code.",
    version: "4.8.4",
    tag: "v4.8.4",
    commit: "bc9ee949d5f439e8b9f3bb92c6d6d3d1e6ebd324",
    repository: "https://github.com/DietrichGebert/ponytail",
    defaultEnabled: true,
    members: ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"],
  },
  {
    id: "caveman",
    displayName: "Caveman",
    description: "Compress instructions and responses while preserving exact technical tokens.",
    version: "v1.9.1",
    tag: "v1.9.1",
    commit: "0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0",
    repository: "https://github.com/JuliusBrussee/caveman",
    defaultEnabled: false,
    // cavecrew requires external agent presets and caveman-stats requires hooks; neither is native-only.
    members: ["caveman", "caveman-commit", "caveman-compress", "caveman-help", "caveman-review"],
  },
  {
    id: "superpowers",
    displayName: "Superpowers",
    description: "Structured brainstorming, planning, TDD, debugging, review, and verification workflows.",
    version: "v6.1.1",
    tag: "v6.1.1",
    commit: "d884ae04edebef577e82ff7c4e143debd0bbec99",
    repository: "https://github.com/obra/superpowers",
    defaultEnabled: true,
    members: [
      "brainstorming",
      "dispatching-parallel-agents",
      "executing-plans",
      "finishing-a-development-branch",
      "receiving-code-review",
      "requesting-code-review",
      "subagent-driven-development",
      "systematic-debugging",
      "test-driven-development",
      "using-git-worktrees",
      "using-superpowers",
      "verification-before-completion",
      "writing-plans",
      "writing-skills",
    ],
  },
] as const

export async function updateEnterpriseSkillPacks(input: { enterpriseDir: string; catalogOnly?: boolean }) {
  if (!input.catalogOnly) {
    const temporary = await mkdtemp(path.join(tmpdir(), "opencode-enterprise-skill-packs-"))
    try {
      for (const source of sources) {
        const checkout = path.join(temporary, source.id)
        await run([process.env.GIT ?? "git", "clone", "--depth", "1", "--branch", source.tag, `${source.repository}.git`, checkout])
        const commit = (await run([process.env.GIT ?? "git", "-C", checkout, "rev-parse", "HEAD"])).trim()
        if (commit !== source.commit) throw new Error(`Unexpected ${source.id} source commit`)
        const destination = path.join(input.enterpriseDir, "skill-packs", source.id)
        await rm(destination, { recursive: true, force: true })
        await mkdir(path.join(destination, "skills"), { recursive: true })
        await Promise.all([
          ...source.members.map((member) =>
            cp(path.join(checkout, "skills", member), path.join(destination, "skills", member), { recursive: true }),
          ),
          cp(path.join(checkout, "LICENSE"), path.join(destination, "LICENSE")),
        ])
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  const catalog = {
    schemaVersion: 1 as const,
    packs: await Promise.all(
      sources.map(async (source) => ({
        id: source.id,
        displayName: source.displayName,
        description: source.description,
        version: source.version,
        repository: source.repository,
        defaultEnabled: source.defaultEnabled,
        root: `skill-packs/${source.id}/skills`,
        members: [...source.members].sort(),
        license: `skill-packs/${source.id}/LICENSE`,
        treeSHA256: await skillPackTreeHash(path.join(input.enterpriseDir, "skill-packs", source.id)),
      })),
    ),
  }
  await Bun.write(path.join(input.enterpriseDir, "skill-packs.json"), `${JSON.stringify(catalog, null, 2)}\n`)
  return catalog
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "inherit" })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command[0]}`)
  return output
}

if (import.meta.main) {
  const enterpriseDir = path.resolve(import.meta.dir, "../resources/enterprise")
  await updateEnterpriseSkillPacks({ enterpriseDir, catalogOnly: process.argv.includes("--catalog-only") })
  const catalog = JSON.parse(await readFile(path.join(enterpriseDir, "skill-packs.json"), "utf8"))
  console.log(`Updated ${catalog.packs.length} enterprise skill packs`)
}
