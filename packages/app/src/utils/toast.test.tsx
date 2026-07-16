import { expect, test } from "bun:test"
import { resolveToastIcon } from "./toast"

test("defers V2 toast icon construction until the toaster render owner runs", () => {
  const icon = resolveToastIcon("circle-check", "success")

  expect(icon).toBeFunction()
})
