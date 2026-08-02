import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({
  plan: Schema.NonEmptyString.annotate({ description: "The complete implementation plan in Markdown" }),
})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.succeed({
    description: EXIT_DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>) =>
      Effect.sync(() => {
        if (!params.plan.trim()) throw new Error("Plan must not be empty")
        return {
          title: "Plan ready",
          output: "Plan mode remains active. Switch to Build and send an implementation request when ready.",
          metadata: { agent: "plan" as const },
        }
      }),
  }),
)
