import { expect, test } from "bun:test"
import { agentLabel, hasCustomAgent, hasPlanMode, resolveAgent } from "./agent"
import { dict } from "@/runtime/i18n/en"

test("hasCustomAgent detects only explicitly custom agents", () => {
  expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
})

const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

const rows: { name: string; agents: { name: string }[]; requested?: string; expected: string }[] = [
  { name: "the requested available agent", agents, requested: "custom", expected: "custom" },
  { name: "build without a request", agents, requested: undefined, expected: "build" },
  { name: "build for a missing agent", agents, requested: "missing", expected: "build" },
  {
    name: "the first agent when build is unavailable",
    agents: [{ name: "custom" }],
    requested: "missing",
    expected: "custom",
  },
]

test.each(rows)("resolveAgent uses $name", (row) => {
  expect(resolveAgent(row.agents, row.requested)?.name).toBe(row.expected)
})

test("exposes Plan only alongside Build and labels built-in modes without renaming custom agents", () => {
  const label = (name: string) => agentLabel(name, (key) => dict[key])
  expect(hasPlanMode([{ name: "build" }, { name: "plan" }])).toBe(true)
  expect(hasPlanMode([{ name: "build" }])).toBe(false)
  expect(label("build")).toBe("Build")
  expect(label("plan")).toBe("Plan · Approval-gated")
  expect(label("reviewer")).toBe("reviewer")
})
