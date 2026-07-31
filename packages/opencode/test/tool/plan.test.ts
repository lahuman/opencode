import { describe, expect, test } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "@/agent/agent"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session/session"
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

function run(
  choice: "Build now" | "Keep planning",
  write: (file: string, content: string | Uint8Array) => Effect.Effect<void, FSUtil.Error> = () => Effect.void,
) {
  const directory = path.resolve("plan-test")
  const instance = {
    directory,
    worktree: directory,
    project: { vcs: "git" },
  } as InstanceContext
  const info = {
    id: ctx.sessionID,
    slug: "sample",
    time: { created: 1, updated: 1 },
  }
  const messages: unknown[] = []
  const parts: unknown[] = []
  let questions = 0

  const layer = Layer.mergeAll(
    Layer.succeed(FSUtil.Service, { writeWithDirs: write } as FSUtil.Interface),
    Layer.mock(Question.Service, {
      ask: () =>
        Effect.sync(() => {
          questions++
          return [[choice]]
        }),
    }),
    Layer.mock(Session.Service, {
      get: () => Effect.succeed(info as never),
      messages: () => Effect.succeed([]),
      updateMessage: (message) =>
        Effect.sync(() => {
          messages.push(message)
          return message
        }),
      updatePart: (part) => Effect.sync(() => parts.push(part)).pipe(Effect.as(part)),
    }),
    Layer.mock(Provider.Service, {
      defaultModel: () =>
        Effect.succeed({ providerID: ProviderV2.ID.opencode, modelID: ModelV2.ID.make("test") }),
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "plan", permission: [] } as never),
    }),
  )

  return {
    effect: PlanExitTool.pipe(
      Effect.flatMap(Tool.init),
      Effect.flatMap((tool) => tool.execute({ plan: "# Plan\n\nDo the work.\n\n" }, ctx)),
      Effect.provide(layer),
      Effect.provideService(InstanceRef, instance),
    ),
    file: path.join(directory, ".opencode", "plans", "1-sample.md"),
    messages,
    parts,
    questions: () => questions,
  }
}

describe("tool.plan_exit", () => {
  test("saves the final plan and stays in Plan when requested", async () => {
    const writes: Array<{ file: string; content: string }> = []
    const test = run("Keep planning", (file, content) =>
      Effect.sync(() => writes.push({ file, content: String(content) })),
    )

    const result = await Effect.runPromise(test.effect)

    expect(writes).toEqual([{ file: test.file, content: "# Plan\n\nDo the work.\n" }])
    expect(result.metadata.agent).toBe("plan")
    expect(test.messages).toHaveLength(0)
    expect(test.parts).toHaveLength(0)
  })

  test("creates one Build message after approval", async () => {
    const test = run("Build now")
    const result = await Effect.runPromise(test.effect)

    expect(result.metadata.agent).toBe("build")
    expect(test.messages).toHaveLength(1)
    expect(test.parts).toHaveLength(1)
    expect(test.messages[0]).toMatchObject({ agent: "build" })
  })

  test("does not ask for approval when saving fails", async () => {
    const test = run("Build now", () =>
      Effect.fail(new FSUtil.FileSystemError({ method: "writeWithDirs", cause: new Error("write failed") })),
    )
    const exit = await Effect.runPromise(test.effect.pipe(Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("write failed")
    expect(test.questions()).toBe(0)
  })
})
