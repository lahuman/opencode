import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { Question } from "@/question"
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

function layer(choice?: "Build now" | "Keep planning") {
  return Layer.mergeAll(
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "plan", permission: [] } as never),
    }),
    Layer.mock(Question.Service, {
      ask: () => (choice ? Effect.succeed([[choice]]) : Effect.fail(new Question.RejectedError())),
    }),
  )
}

function run(plan: string, choice?: "Build now" | "Keep planning") {
  return PlanExitTool.pipe(
    Effect.flatMap(Tool.init),
    Effect.flatMap((tool) => tool.execute({ plan }, ctx)),
    Effect.provide(layer(choice)),
  )
}

describe("tool.plan_exit", () => {
  test("keeps Plan mode after selecting Keep planning", async () => {
    const result = await Effect.runPromise(run("# Plan\n\nDo the work.", "Keep planning"))

    expect(result).toMatchObject({
      title: "Plan ready",
      output: "Staying in Plan mode. The conversation plan remains authoritative.",
      metadata: { agent: "plan" },
    })
  })

  test("keeps Plan mode when the Build card is dismissed", async () => {
    const result = await Effect.runPromise(run("# Plan\n\nDo the work."))

    expect(result.metadata.agent).toBe("plan")
  })

  test("switches to Build after the Build card is approved", async () => {
    const result = await Effect.runPromise(run("# Plan\n\nDo the work.", "Build now"))

    expect(result).toMatchObject({
      title: "Build mode ready",
      output: "Build mode is ready. Send an implementation request when ready.",
      metadata: { agent: "build" },
    })
  })

  test("rejects whitespace-only plans", async () => {
    const exit = await Effect.runPromise(run(" \n ").pipe(Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Plan must not be empty")
  })
})
