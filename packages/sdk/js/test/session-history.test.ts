import { expect, test } from "bun:test"
import type { V2SessionHistoryData } from "../src/v2/gen/types.gen"

test("uses numeric Session history positions", () => {
  const input = {
    path: { sessionID: "ses_test" },
    query: { after: 1, limit: 50 },
    url: "/api/session/{sessionID}/history",
  } satisfies V2SessionHistoryData

  expect(input.query.after).toBe(1)
})

test("guards the history SDK patch against its immediate input", async () => {
  const source = await Bun.file(new URL("../script/build.ts", import.meta.url)).text()
  const patch = source.slice(
    source.indexOf("const historySdkPatched"),
    source.indexOf('await Bun.write("./src/v2/gen/sdk.gen.ts"'),
  )

  expect(patch).toContain("if (historySdkPatched === diagnosticSdkPatched)")
  expect(patch).not.toContain("if (historySdkPatched === generatedSdk)")
})
