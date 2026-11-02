import { Show } from "solid-js"
import type { FormAnswer, FormInfo } from "@opencode/client/promise"
import { useSettings } from "@/settings/model"
import { useLocal } from "@/providers/models/selection"
import { useData } from "@/runtime/server/current"
import { usePlatform } from "@/runtime/platform/platform"
import { isPlanBuildApproval } from "./plan-build-approval"
import { SessionQuestionDockClassic } from "./session-question-dock-classic"
import { SessionQuestionDockExperimental } from "./session-question-dock-experimental"

export function SessionQuestionDock(props: { request: FormInfo; onSubmit: () => void }) {
  const settings = useSettings()
  const platform = usePlatform()
  const local = useLocal()
  const data = useData()
  const onAnswered = (answer: FormAnswer) => {
    if (platform.platform !== "desktop") return
    const tools = (data.session.message.list(props.request.sessionID) ?? []).flatMap((message) =>
      message.type === "assistant"
        ? message.content.flatMap((part) =>
            part.type === "tool" ? [{ messageID: message.id, id: part.id, name: part.name }] : [],
          )
        : [],
    )
    if (!isPlanBuildApproval({ request: props.request, answer, tools })) return
    local.agent.set("build")
    local.agent.setDefault("build")
  }

  return (
    <Show
      when={settings.general.newQuestionUI()}
      fallback={<SessionQuestionDockClassic {...props} onAnswered={onAnswered} />}
    >
      <SessionQuestionDockExperimental {...props} onAnswered={onAnswered} />
    </Show>
  )
}
