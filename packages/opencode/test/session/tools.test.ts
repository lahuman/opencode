import { describe, expect, test } from "bun:test"
import { resolvePermissionRules, restrictPlanTools } from "@/session/tools"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"

describe("session tools", () => {
  test("keeps only read-only tools for the Plan agent", () => {
    const tools = restrictPlanTools("plan", {
      bash: 0,
      read: 1,
      plan_exit: 2,
      list_mcp_resources: 3,
      database_write: 4,
      custom_plugin: 5,
    })

    expect(tools).toEqual({ bash: 0, read: 1, plan_exit: 2, list_mcp_resources: 3 })
  })

  test("does not restrict Build tools", () => {
    const tools = { read: 1, database_write: 2 }
    expect(restrictPlanTools("build", tools)).toBe(tools)
  })

  test("keeps Plan shell approval after agent and session permissions", () => {
    const ruleset = resolvePermissionRules({
      agent: { permission: Permission.fromConfig({ bash: "allow" }) } as Agent.Info,
      agentID: "plan",
      permission: Permission.fromConfig({ bash: "allow" }),
    })

    expect(Permission.evaluate("bash", "git status", ruleset).action).toBe("ask")
  })
})
