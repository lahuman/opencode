export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function hasPlanMode(items: Array<{ name: string }>) {
  return items.some((item) => item.name === "build") && items.some((item) => item.name === "plan")
}

export function agentLabel(
  name: string,
  translate: (key: "enterprise.agent.build" | "enterprise.agent.plan") => string,
) {
  if (name === "build") return translate("enterprise.agent.build")
  if (name === "plan") return translate("enterprise.agent.plan")
  return name
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
