import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({
  plan: Schema.NonEmptyString.annotate({ description: "The complete implementation plan in Markdown" }),
})

type Metadata = {
  agent: "plan" | "build"
}

export const PlanExitTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "plan_exit",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.plan.trim()) throw new Error("Plan must not be empty")
          const answers = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  question: "The plan is ready. Would you like to switch to Build?",
                  header: "Build Agent",
                  custom: false,
                  options: [
                    { label: "Build now", description: "Switch to Build and send an implementation request" },
                    { label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
                  ],
                },
              ],
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })
            .pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed([])))

          if (answers[0]?.[0] !== "Build now") {
            return {
              title: "Plan ready",
              output: "Staying in Plan mode. The conversation plan remains authoritative.",
              metadata: { agent: "plan" } satisfies Metadata,
            }
          }

          return {
            title: "Build mode ready",
            output: "Build mode is ready. Send an implementation request when ready.",
            metadata: { agent: "build" } satisfies Metadata,
          }
        }),
    }
  }),
)
