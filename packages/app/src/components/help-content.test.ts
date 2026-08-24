import { expect, test } from "bun:test"
import { CHAI_ONBOARDING, onboardingContent } from "./help-content"

test("defines the approved Korean CHAI onboarding copy", () => {
  expect(CHAI_ONBOARDING.card).toEqual({
    ariaLabel: "CHAI 시작 안내. 코드 분석부터 검증까지 AI 코딩 작업 흐름을 확인합니다.",
    dismissLabel: "CHAI 시작 안내 닫기",
    title: "CHAI 시작하기",
    description: "코드 분석부터 구현과 검증까지 한곳에서 진행하세요.",
  })
  expect(CHAI_ONBOARDING.drawer).toMatchObject({
    header: "시작 안내",
    closeLabel: "닫기",
    title: "CHAI AI Coding Workspace",
  })
  expect(CHAI_ONBOARDING.drawer.sections.map((section) => section.title)).toEqual(["분석", "구현", "검증"])
  expect(CHAI_ONBOARDING.drawer.offline).toContain("폐쇄망")
  expect(CHAI_ONBOARDING.drawer.guide).toContain("CHAI AI 가이드")
})

test("selects CHAI onboarding only for enterprise editions", () => {
  expect(onboardingContent(true)).toBe(CHAI_ONBOARDING)
  expect(onboardingContent(false).card).toMatchObject({
    title: "Introducing Tabs",
    description: "Organize your work and active sessions with tabs",
  })
  expect(onboardingContent(false).drawer.title).toBe("Introducing Tabs")
})
