import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { MessageID, PartID } from "@/session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({
  plan: Schema.NonEmptyString.annotate({ description: "The complete implementation plan in Markdown" }),
})

type Metadata = {
  agent: "plan" | "build"
}

export const PlanExitTool = Tool.define<typeof Parameters, Metadata, Question.Service | Session.Service | Provider.Service>(
  "plan_exit",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const session = yield* Session.Service
    const provider = yield* Provider.Service

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

          const lastUser = ctx.messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model
              ? lastUser.info.model
              : yield* provider.defaultModel().pipe(Effect.orDie)
          const message: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(message)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: message.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The following plan has been approved. Implement it now.\n\n${params.plan.trim()}`,
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: "Starting Build agent",
            output: "The approved plan is now running in Build mode.",
            metadata: { agent: "build" } satisfies Metadata,
          }
        }),
    }
  }),
)
