import path from "node:path"

import { skillPackTreeHash } from "../src/main/enterprise-skill-packs"

const sources = [
  {
    id: "analyze-codebase",
    displayName: "Codebase Analysis",
    description: "기존 코드의 구조, 동작 흐름, 변경 영향 범위를 분석합니다.",
    version: "1.0.0",
    repository: "https://github.com/anomalyco/opencode",
    defaultEnabled: true,
    members: ["analyze-codebase"],
  },
  {
    id: "debug-problems",
    displayName: "Problem Debugging",
    description: "버그, 테스트 실패, 빌드 오류의 근본 원인을 체계적으로 조사합니다.",
    version: "1.0.0",
    repository: "https://github.com/anomalyco/opencode",
    defaultEnabled: true,
    members: ["debug-problems"],
  },
  {
    id: "verify-changes",
    displayName: "Change Verification",
    description: "변경사항을 테스트, 타입 검사, 빌드와 diff로 최종 검증합니다.",
    version: "1.0.0",
    repository: "https://github.com/anomalyco/opencode",
    defaultEnabled: true,
    members: ["verify-changes"],
  },
] as const

export async function updateEnterpriseSkillPacks(input: { enterpriseDir: string; catalogOnly?: boolean }) {
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

if (import.meta.main) {
  const enterpriseDir = path.resolve(import.meta.dir, "../resources/enterprise")
  const catalog = await updateEnterpriseSkillPacks({
    enterpriseDir,
    catalogOnly: process.argv.includes("--catalog-only"),
  })
  console.log(`Updated ${catalog.packs.length} enterprise skill packs`)
}
