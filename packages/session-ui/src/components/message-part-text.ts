export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

export function planExitDisplay(input: unknown, status?: string, output?: string) {
  const plan =
    input && typeof input === "object" && "plan" in input && typeof input.plan === "string" ? input.plan.trim() : ""
  return {
    plan,
    subtitle: status === "completed" ? output : undefined,
    ready: status === "completed",
  }
}
