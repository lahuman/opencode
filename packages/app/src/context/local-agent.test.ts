import { describe, expect, test } from "bun:test"
import { agentLabel, hasCustomAgent, hasPlanMode, resolveAgent } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})

describe("hasPlanMode", () => {
  test("requires both built-in mode agents", () => {
    expect(hasPlanMode([{ name: "build" }, { name: "plan" }])).toBe(true)
    expect(hasPlanMode([{ name: "build" }])).toBe(false)
  })
})

describe("agentLabel", () => {
  test("labels built-in modes without changing custom names", () => {
    expect(agentLabel("build")).toBe("Build")
    expect(agentLabel("plan")).toBe("Plan · Approval-gated")
    expect(agentLabel("reviewer")).toBe("reviewer")
  })
})
