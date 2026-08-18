export const SFMI_ONBOARDING = {
  card: {
    ariaLabel: "SFMI 시작 안내. 코드 분석부터 검증까지 AI 코딩 작업 흐름을 확인합니다.",
    dismissLabel: "SFMI 시작 안내 닫기",
    title: "SFMI 시작하기",
    description: "코드 분석부터 구현과 검증까지 한곳에서 진행하세요.",
  },
  drawer: {
    header: "시작 안내",
    closeLabel: "닫기",
    title: "SFMI AI Coding Workspace",
    intro:
      "SFMI는 저장소의 맥락을 이해하고 필요한 변경을 구현한 뒤 결과를 근거로 검증하는 AI 코딩 작업공간입니다.",
    sections: [
      { title: "분석", description: "저장소 구조와 기존 코드를 근거로 변경 범위와 영향을 이해합니다." },
      { title: "구현", description: "필요한 변경에 집중하고 문제 원인을 체계적으로 해결합니다." },
      { title: "검증", description: "테스트, 타입 검사, 빌드와 변경 내역을 확인한 뒤 결과를 마무리합니다." },
    ],
    offline: "SFMI는 통제된 폐쇄망 환경을 위해 설계되며, 설정된 내부 AI 서비스만 사용합니다.",
    guide: "자세한 운영 기준은 도움말 메뉴의 SFMI AI 가이드에서 확인할 수 있습니다.",
  },
} as const

const PUBLIC_TABS_ONBOARDING = {
  card: {
    ariaLabel: "Introducing Tabs. Organize your work and active sessions with tabs",
    dismissLabel: "Dismiss Tabs information",
    title: "Introducing Tabs",
    description: "Organize your work and active sessions with tabs",
  },
  drawer: {
    header: "July 14",
    closeLabel: "Close",
    title: "Introducing Tabs",
  },
} as const

export function onboardingContent(enterprise: boolean) {
  if (enterprise) return SFMI_ONBOARDING
  return PUBLIC_TABS_ONBOARDING
}
