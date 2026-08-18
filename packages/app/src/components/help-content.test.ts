import { expect, test } from "bun:test"
import { SFMI_ONBOARDING, onboardingContent } from "./help-content"

test("defines the approved Korean SFMI onboarding copy", () => {
  expect(SFMI_ONBOARDING.card).toEqual({
    ariaLabel: "SFMI 시작 안내. 코드 분석부터 검증까지 AI 코딩 작업 흐름을 확인합니다.",
    dismissLabel: "SFMI 시작 안내 닫기",
    title: "SFMI 시작하기",
    description: "코드 분석부터 구현과 검증까지 한곳에서 진행하세요.",
  })
  expect(SFMI_ONBOARDING.drawer).toMatchObject({
    header: "시작 안내",
    closeLabel: "닫기",
    title: "SFMI AI Coding Workspace",
  })
  expect(SFMI_ONBOARDING.drawer.sections.map((section) => section.title)).toEqual(["분석", "구현", "검증"])
  expect(SFMI_ONBOARDING.drawer.offline).toContain("폐쇄망")
  expect(SFMI_ONBOARDING.drawer.guide).toContain("SFMI AI 가이드")
})

test("selects SFMI onboarding only for enterprise editions", () => {
  expect(onboardingContent(true)).toBe(SFMI_ONBOARDING)
  expect(onboardingContent(false).card).toMatchObject({
    title: "Introducing Tabs",
    description: "Organize your work and active sessions with tabs",
  })
  expect(onboardingContent(false).drawer.title).toBe("Introducing Tabs")
})
