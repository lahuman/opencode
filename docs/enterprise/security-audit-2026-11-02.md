# CHAI Desktop 2.2.6 보안 점검

점검일: 2026-11-02. 대상은 `enterprise-pilot`의 Windows x64 폐쇄망 데스크톱과 해당 빌드에 사용하는 Bun 잠금 파일이다.

## 후속 배포 기록

정보(i) 화면을 CHAI 로고만 표시하도록 변경한 최신 2.2.6 ZIP은 `packages/desktop/dist/about-chai/chai-2.2.6-win-x64.zip`이다. 소스 커밋은 `8c53609538b86d8a4ab9114a468b098e81399060`, SHA-256은 `677e6d6c672c1a3ab9d160304054e33429876fa2f78e64a1252133e9ed3e8b5b`이다. 이전 보안 패치본은 `dist/security-update`에 보존했다. 같은 파일명과 버전을 사용하므로 릴리스 메타데이터의 커밋과 해시로 구분한다.

새 배포 파일에서도 Electron 44.10.1 / Node.js 24.22.1 / Undici 7.30.1 / Bun 1.4.4와 서버 버전 2.2.6을 확인했다. 정보 화면 변경에는 의존성 수정이 없어 아래의 미해결 권고와 검증 범위는 그대로다. 최신 패키징 테스트 52개와 파일·체크섬 검증은 통과했다. 정보 화면 변경 후 첫 전체 검사 재시도는 린터 메모리 할당 오류로 완료하지 못했지만, 이후 개발용 `oxlint`와 `@oxlint/plugins`를 Windows 할당 수정이 포함된 1.65.0으로 함께 갱신하자 기존 `bun run check` 전체 린트·35개 타입 검사가 통과했다. 훅과 검사 규칙은 유지했다. 갱신 후 재감사에서도 9개 패키지·47개 권고(높음 19, 보통 22, 낮음 6)가 남았다. 아래의 검증 목록은 보안 패치 단계의 기록이며, 후속 검사와 구분한다. 배포 절차와 최신 검증 결과는 [Windows 배포 문서](windows-portable-chai-release.md#latest-build-record-2026-11-02)를 따른다.

## 결론과 범위

기존 2.2.5 배포본의 실제 `CHAI.exe`를 `ELECTRON_RUN_AS_NODE=1`로 실행해 Electron 44.9.1, Node.js 24.22.0, Undici 7.29.1을 확인했다. 이 조합에는 2026-10-21 Node.js 보안 릴리스가 반영되어 있지 않았다. 개발 PC의 별도 Node.js는 22.23.4로 이미 해당 보안 릴리스 버전이었다. PC의 Node.js를 갱신하는 것만으로 앱에 내장된 런타임은 갱신되지 않는다.

2.2.6은 Electron 44.10.1을 사용해 Node.js 24.22.1 및 Undici 7.30.1 보안 수정을 반영한다. [Node.js 보안 릴리스](https://nodejs.org/en/blog/release/v24.22.1)는 Brotli, TLS, DNS, HTTP, crypto, permission 관련 수정을 열거한다. [Electron 44.10.1 릴리스](https://releases.electronjs.org/release/v44.10.1)는 내장 Node.js 버전과 Chromium 보완 사항을 명시한다.

내장 서버를 컴파일하는 Bun은 기존의 1.4.4 고정을 유지한다. 기존 내장 서버도 `BUN_BE_BUN=1` 런타임 조회 모드에서 1.4.4임을 확인했다. [Bun의 Brotli 보안 권고](https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p)는 CVE-2026-111497의 수정 버전을 1.4.4로 명시한다. 컴파일된 실행 파일에는 런타임이 내장되므로 새 서버도 이 버전으로 다시 빌드한다.

**이 결과는 전체 npm 의존성의 취약점 해소를 의미하지 않는다.** 전체 워크스페이스 `bun audit --json`은 수정 전 13개 패키지의 67개 권고를 보고했고, 수정 후에는 9개 패키지의 47개 권고(높음 19, 보통 22, 낮음 6)를 보고한다. 이 수치는 취약한 설치 사본 수가 아닌 패키지별 보안 권고 수다. npm 감사는 Electron 내부의 Node.js 버전 검증을 대신하지 않는다.

## 적용 내용

| 항목 | 이전 | 적용 버전 / 범위 |
| --- | --- | --- |
| Electron | 44.9.1 | 44.10.1, desktop 및 GUI 플러그인 일치 |
| `@ai-sdk/provider-utils` | OpenAI 호환 공급자의 4.0.23 | 해당 부모의 직접 의존성만 4.0.33으로 재정의. 다른 공급자의 4.0.62 유지 |
| `@xmldom/xmldom` | 0.8.14 | 0.8.15 |
| `fast-uri` | 3.1.5 | 3.1.9 |
| `serialize-javascript` | 7.1.0 | 7.1.3 |
| 직접 사용하는 `glob` | 13.0.5 | 14.0.2 |
| util이 직접 사용하는 `minimatch` | 10.2.5 | 11.0.1 |

모든 공급자를 같은 `provider-utils` 버전으로 강제하는 대신 부모별 재정의를 사용한다. SSE 타임아웃 회귀 테스트가 통과한 최소 보안 패치 버전을 선택했다. 부모별 재정의로 Bun 잠금 파일 형식은 버전 3이 되었으며, 저장소에 고정된 Bun 1.4.4로 설치를 검증했다.

앱, 내장 서버, 루트 배포 버전을 2.2.6으로 올렸다. 데스크톱은 이미 존재하는 같은 버전의 내장 서버를 재사용하므로, 2.2.5를 유지하면 이전 서버가 재사용될 수 있다. 사용자 설정이나 대화 데이터를 초기화할 필요는 없다.

## 남은 보안 권고

| 패키지 | 권고 수 | 남은 경로 및 처리 한계 |
| --- | ---: | --- |
| `undici` | 34 | Cloudflare 개발 도구의 Miniflare가 고정한 7.x 사본. 앱 내장 Node.js의 Undici와 별개 |
| `sharp` | 3 | Miniflare의 이전 버전 사본 |
| `wrangler` | 1 | console/app의 개발 도구 4.50.0 |
| `ws` | 2 | 같은 console/app → Wrangler → Miniflare 경로의 8.18.0 |
| `happy-dom` | 3 | 앱·GUI 플러그인 등의 테스트 환경 |
| `deepmerge` | 1 | Rollup 빌드 플러그인의 4.3.1. 감사 도구가 제시하는 이전 버전은 부모의 요구 범위를 충족하지 않음 |
| `glob` | 1 | npm 설치·빌드 도구 등이 사용하는 이전 메이저 버전. util의 직접 사용 버전은 수정됨 |
| `minimatch` | 1 | npm 설치·패키징·빌드 도구의 이전 메이저 버전 사본. util의 직접 사용 버전은 수정됨 |
| `zod` | 1 | Lighthouse → Puppeteer → chromium-bidi 및 core → gitlab-ai-provider의 3.25.76, Miniflare의 3.22.3 |

특히 `zod` 3.25.76은 기존 배포본의 `app.asar` 외부 의존성에서도 확인했다. 따라서 남은 항목을 전부 개발용이라고 분류할 수 없다. [관련 권고](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)는 4.6.6 미만을 영향 범위로 제시한다. 부모 패키지가 3.x API를 요구하므로 4.x로 일괄 강제하지 않았다. 해당 부모 업데이트와 기능 호환성 검증이 후속 조치다. `glob`과 `minimatch` 역시 부모별 API 호환성을 확인해야 하며, 오래된 메이저 버전을 일괄 재정의하지 않았다.

SBOM은 전체 워크스페이스 잠금 파일을 수집한다. `app.asar` 외부 패키지 목록만으로는 렌더러 및 내장 서버에 번들된 코드 전체의 포함 여부를 판정할 수 없다. 이번 점검은 침투 테스트, 모든 CVE의 악용 가능성 증명, 폐쇄망 실환경 인수 시험을 대체하지 않는다.

## 검증

- `bun run check`: 전체 린트와 35개 타입 검사 작업 통과.
- 배포 버전 변경 후 재검사에서 oxlint의 기본 작업자 수에 따른 메모리 할당 실패가 발생했다. 저장소 스크립트는 변경하지 않고 oxlint에 `--threads=2`를 적용해 같은 린트·ast-grep·SDK 문서·전체 타입 검사 항목을 다시 실행해 모두 통과했다.
- core의 `aisdk.test.ts`, `aisdk-native.test.ts`: 67개 통과. SSE 스트리밍·타임아웃 포함.
- desktop의 폐쇄망 빌드·공급자·자격 증명·자식 프로세스 관련 8개 파일: 114개 통과.
- util 단위 테스트: 139개 통과, 기존 1개 건너뜀.
- 실제 `Glob.scan` / `Glob.match`로 중괄호 확장, 제외 경로, 숨김 파일, 절대 경로, 포함·불일치를 확인.
- `bun install --frozen-lockfile`: 통과.

감사 원문 및 실행 로그는 저장소의 `.cache/security-audit/`에 보관한다. 배포 파일의 실제 커밋·체크섬·서명 상태는 ZIP 옆의 `.release.json`과 `.sha256`을 기준으로 한다. 기존에 실행 중인 사용자 앱이나 내부 서버는 종료하거나 재시작하지 않았다.
