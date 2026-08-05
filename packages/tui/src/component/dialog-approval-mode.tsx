import type { ApprovalMode } from "../context/permission"
import { DialogSelect } from "../ui/dialog-select"

const options = [
  { title: "Ask for approval", value: "ask" },
  { title: "Approve for me", value: "auto_review" },
] satisfies { title: string; value: ApprovalMode }[]

export function DialogApprovalMode(props: {
  current: ApprovalMode
  pending: () => boolean
  onSelect: (value: ApprovalMode) => Promise<void>
}) {
  return (
    <DialogSelect
      title="Approval mode"
      current={props.current}
      options={options}
      locked={props.pending()}
      onSelect={(option) => void props.onSelect(option.value)}
    />
  )
}
