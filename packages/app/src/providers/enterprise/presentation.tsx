import { Field } from "@opencode/ui/field"
import { TextInput } from "@opencode/ui/text-input"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { type ComponentProps, type JSX, splitProps } from "solid-js"

export function EnterpriseDialog(
  props: ComponentProps<typeof Dialog> & { title: JSX.Element; description?: JSX.Element },
) {
  const [local, rest] = splitProps(props, ["title", "description", "children"])
  return (
    <Dialog {...rest}>
      <DialogHeader>
        <DialogTitleGroup title={local.title} description={local.description} />
      </DialogHeader>
      <DialogBody>{local.children}</DialogBody>
    </Dialog>
  )
}

export function EnterpriseField(
  props: Omit<ComponentProps<typeof TextInput>, "onChange"> & {
    label: string
    hideLabel?: boolean
    onChange: (value: string) => void
  },
) {
  const [local, rest] = splitProps(props, ["label", "hideLabel", "onChange"])
  return (
    <Field>
      <Field.Label classList={{ "sr-only": local.hideLabel }}>{local.label}</Field.Label>
      <TextInput {...rest} onInput={(event) => local.onChange(event.currentTarget.value)} />
    </Field>
  )
}
