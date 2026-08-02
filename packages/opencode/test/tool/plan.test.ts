import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { PlanExitTool } from "@/tool/plan"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_plan"),
  messageID: MessageID.make("msg_plan"),
  callID: "call_plan",
  agent: "plan",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const layer = Layer.mergeAll(
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
  }),
  Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ name: "plan", permission: [] } as never),
  }),
)

function run(plan: string) {
  return PlanExitTool.pipe(
    Effect.flatMap(Tool.init),
    Effect.flatMap((tool) => tool.execute({ plan }, ctx)),
    Effect.provide(layer),
  )
}

describe("tool.plan_exit", () => {
  test("presents the authoritative plan and stays in Plan mode", async () => {
    const result = await Effect.runPromise(run("# Plan\n\nDo the work."))

    expect(result).toMatchObject({
      title: "Plan ready",
      output: "Plan mode remains active. Switch to Build and send an implementation request when ready.",
      metadata: { agent: "plan" },
    })
  })

  test("rejects whitespace-only plans", async () => {
    const exit = await Effect.runPromise(run(" \n ").pipe(Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Plan must not be empty")
  })
})
