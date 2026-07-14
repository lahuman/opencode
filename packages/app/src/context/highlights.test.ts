import { expect, test } from "bun:test"
import { loadReleaseHighlightsForEdition, shouldLoadReleaseHighlights } from "./highlights"

test("enterprise edition never loads public release highlights", () => {
  expect(shouldLoadReleaseHighlights(true)).toBe(false)
  expect(shouldLoadReleaseHighlights(false)).toBe(true)
})

test("enterprise provider marks the current version seen before fetcher selection", () => {
  const calls: string[] = []
  const platform = {
    enterprise: {},
    version: "2.0.0",
    get fetch() {
      calls.push("select fetcher")
      return (_input: RequestInfo | URL) => {
        calls.push("network")
        return Promise.resolve(new Response())
      }
    },
  }

  loadReleaseHighlightsForEdition({
    enterprise: Boolean(platform.enterprise),
    markSeen: () => calls.push(`seen ${platform.version}`),
    load: () => {
      const fetcher = platform.fetch ?? fetch
      void fetcher("https://opencode.ai/changelog.json")
    },
  })

  expect(calls).toEqual(["seen 2.0.0"])
})

test("public provider preserves release-highlight loading", () => {
  const calls: string[] = []

  loadReleaseHighlightsForEdition({
    enterprise: false,
    markSeen: () => calls.push("seen"),
    load: () => calls.push("load"),
  })

  expect(calls).toEqual(["load"])
})
