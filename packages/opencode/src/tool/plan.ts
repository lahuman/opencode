import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({
  plan: Schema.NonEmptyString.annotate({ description: "The complete implementation plan in Markdown" }),
})

type Metadata = {
  agent: "plan" | "build"
  plan?: string
}

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const fsys = yield* FSUtil.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const file = Session.plan(info, instance)
          const plan = path.relative(instance.worktree, file)
          if (!params.plan.trim()) return yield* Effect.die(new Error("Plan must not be empty"))
          const answers = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  question: "The plan is ready. Would you like to switch to Build and start implementing?",
                  header: "Build Agent",
                  custom: false,
                  options: [
                    { label: "Build now", description: "Save a compatibility copy and start implementing" },
                    { label: "Keep planning", description: "Keep the conversation plan and continue refining it" },
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
              metadata: { agent: "plan" } as Metadata,
            }
          }

          yield* fsys.writeWithDirs(file, params.plan.trimEnd() + "\n")
          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved the plan. Switch to Build and execute the saved plan.",
            metadata: { agent: "build", plan } as Metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
