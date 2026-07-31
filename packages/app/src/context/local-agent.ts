export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function hasPlanMode(items: Array<{ name: string }>) {
  return items.some((item) => item.name === "build") && items.some((item) => item.name === "plan")
}

export function agentLabel(name: string) {
  if (name === "build") return "Build"
  if (name === "plan") return "Plan · Read-only"
  return name
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
