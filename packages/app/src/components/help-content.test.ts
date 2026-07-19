import { expect, test } from "bun:test"
import { KERNEXA_ONBOARDING } from "./help-content"

test("defines the approved Korean Kernexa onboarding copy", () => {
  expect(KERNEXA_ONBOARDING.card).toEqual({
    ariaLabel: "Kernexa 시작 안내. 코드 분석부터 검증까지 AI 코딩 작업 흐름을 확인합니다.",
    dismissLabel: "Kernexa 시작 안내 닫기",
    title: "Kernexa 시작하기",
    description: "코드 분석부터 구현과 검증까지 한곳에서 진행하세요.",
  })
  expect(KERNEXA_ONBOARDING.drawer).toMatchObject({
    header: "시작 안내",
    closeLabel: "닫기",
    title: "Kernexa AI Coding Workspace",
  })
  expect(KERNEXA_ONBOARDING.drawer.sections.map((section) => section.title)).toEqual(["분석", "구현", "검증"])
  expect(KERNEXA_ONBOARDING.drawer.offline).toContain("폐쇄망")
  expect(KERNEXA_ONBOARDING.drawer.guide).toContain("Kernexa AI 가이드")
})
