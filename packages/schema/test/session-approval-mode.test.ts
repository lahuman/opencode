import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionV1 } from "../src/v1/session"

const currentWithoutMode = {
  id: Session.ID.create(),
  projectID: Project.ID.global,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  title: "Session",
  location: { directory: "/tmp" },
}

const currentForMake = {
  ...currentWithoutMode,
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: { directory: AbsolutePath.make("/tmp") },
}

const legacyWithoutMode = SessionV1.SessionInfo.make({
  id: Session.ID.create(),
  slug: "session",
  projectID: Project.ID.global,
  directory: "/tmp",
  title: "Session",
  version: "1",
  time: { created: 0, updated: 0 },
})

const decodeCurrent = Schema.decodeUnknownSync(Session.Info)
const decodeLegacy = Schema.decodeUnknownSync(SessionV1.SessionInfo)

function expectApprovalMode(value: "ask" | "auto_review") {
  return value
}

describe("session approval mode", () => {
  test("defaults missing modes and validates explicit modes", () => {
    expect(decodeCurrent(currentWithoutMode).approvalMode).toBe("ask")
    expect(decodeLegacy(legacyWithoutMode).approvalMode).toBe("ask")
    expect(decodeCurrent({ ...currentWithoutMode, approvalMode: "auto_review" }).approvalMode).toBe("auto_review")
    expect(() => decodeCurrent({ ...currentWithoutMode, approvalMode: "always" })).toThrow()
    expect(Session.Info.make(currentForMake).approvalMode).toBe("ask")
    expect(SessionV1.SessionInfo.make({ ...legacyWithoutMode }).approvalMode).toBe("ask")
    expectApprovalMode(decodeCurrent(currentWithoutMode).approvalMode)
  })
})
