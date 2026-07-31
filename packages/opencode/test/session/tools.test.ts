import { describe, expect, test } from "bun:test"
import { restrictPlanTools } from "@/session/tools"

describe("session tools", () => {
  test("keeps only read-only tools for the Plan agent", () => {
    const tools = restrictPlanTools("plan", {
      read: 1,
      plan_exit: 2,
      list_mcp_resources: 3,
      database_write: 4,
      custom_plugin: 5,
    })

    expect(tools).toEqual({ read: 1, plan_exit: 2, list_mcp_resources: 3 })
  })

  test("does not restrict Build tools", () => {
    const tools = { read: 1, database_write: 2 }
    expect(restrictPlanTools("build", tools)).toBe(tools)
  })
})
