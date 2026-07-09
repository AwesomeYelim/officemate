# OfficeMate — 지란지교 해커톤 2026 제출물

OfficeMate는 오피스챗에 붙는 AI 매칭 어시스턴트로, 동료 간 식사·번개 모임을 자동으로 개설·매칭·정산합니다. 이 리포는 해커톤 제출물(랜딩 데모, 사업계획서, 화면 목업, HR 콘솔 시뮬레이터)을 정적 사이트로 묶은 것입니다.

## 🌐 배포 주소

- **정식: https://officemate.namo.site** — 하위 페이지는 루트 경로 (`/biz-plan`, `/hr-console` 등). `namo.site/ba4`는 빌더 미리보기일 뿐 공개 주소가 아님
- **미러: https://officemate-five.vercel.app** — push 즉시 반영되는 확인용

`main` 브랜치에 push하면 두 곳 모두 자동 배포됩니다 (팀원 push 포함, 별도 절차 없음).

## 배포

두 트랙을 병행합니다.

- **namo.site = 정식.** `main` push 또는 [Actions 탭에서 수동 실행](../../actions/workflows/deploy.yml) 시 `scripts/deploy.mjs`가 GitHub Actions에서 SiteBuilder MCP로 각 HTML을 페이지 단위로 전송합니다 (리포 Secrets `SB_TOKEN`/`SB_SITE_ID` 설정 완료). namo 쪽 변경은 승인 큐를 거칠 수 있습니다.
- **Vercel = 즉시 반영 미러.** `main` push → 위 주소에 곧바로 반영. 급한 확인·발표 백업용.

동작 방식 (`.github/workflows/deploy.yml` → `scripts/deploy.mjs`):

1. push 이벤트면 변경된 `*.html`만, `workflow_dispatch`(수동 실행)면 6개 파일 전부를 대상으로 함.
2. 대상 파일마다 `list_pages`로 namo의 기존 페이지 목록을 받아 파일명(slug: `index`/`landing`/`biz-plan`/`hr-console`/`flow-mockup`/`journey-mockup`) 우선, 없으면 `<title>` 일치로 대응 페이지를 찾음.
3. 대응 페이지가 없으면 `create_page`로 새로 만든 뒤 그 id를 사용.
4. 찾은(또는 만든) 페이지 id로 `update_page_html` 호출 — 본문은 이 리포의 HTML에서 `<head>`의 `<style>` 블록(리셋 + 메인 CSS)과 `<body>` 내부(마크업 + `<script>` 포함)를 그대로 이어붙인 것. 발행된 namo 사이트는 Vercel과 동일하게 루트 경로로 서빙되므로 내부 링크는 그대로 두며, 혹시 서브패스 배포로 바뀌면 `SB_PUBLIC_BASE` 환경변수로 프리픽스 재작성을 켤 수 있음(기본 꺼짐).
5. namo 쪽 필드 스키마(특히 `list_pages`/`create_page`의 응답 id 필드명)는 실제 토큰 없이 작성되어 확정되지 않았음 — 실패 시 HTTP 응답 원문을 로그에 그대로 출력하도록 되어 있어, 실제 실행 로그로 교정 가능.

로컬에서 시크릿 없이 계획만 확인하려면:

```
DRY_RUN=1 node scripts/deploy.mjs
```

파일 → slug → 예정 동작 → 바이트 수만 출력하고 API 호출은 하지 않음. 실제 배포에는 리포 Secrets에 `SB_TOKEN`, `SB_SITE_ID`가 설정되어 있어야 함.

## 페이지 목록

| 경로 | 내용 |
|---|---|
| [/](https://officemate-five.vercel.app/) | 랜딩페이지 + 라이브 데모 (메인 · `#demo` 앵커로 데모 섹션 진입, 하단 `#deliverables`에 제출물 링크) |
| [/landing](https://officemate-five.vercel.app/landing) | `/`로 리다이렉트 (구 링크 호환용) |
| [/biz-plan](https://officemate-five.vercel.app/biz-plan) | 사업계획서 — 3층 수익구조·리텐션 가설·SOM 모델 |
| [/flow-mockup](https://officemate-five.vercel.app/flow-mockup) | 핵심 매칭 플로우 목업 (7화면) |
| [/journey-mockup](https://officemate-five.vercel.app/journey-mockup) | 사용자 여정 목업 (5화면) |
| [/hr-console](https://officemate-five.vercel.app/hr-console) | HR 콘솔 시뮬레이터 (8페이지 인터랙티브) |

## 라이브 데모 주요 기능

- 자연어 한 줄로 모임 개설 ("목요일 점심에 매운 거 먹을 사람 3명") → AI 파싱
- 슬롯 직접 선택(시간대 탭) + 인원 스테퍼, 온·오프라인 자동판별
- 디파짓(500P) → 매칭 게이지 → 확정/방폭 분기 → 체크인(QR/온라인)
- n-빵 정산: 총액 선결제 → 참석자 요청 → 순차 입금 → 영수증 증빙 (노쇼자 제외)
- 🔬 엔진 인스펙터(PARSE/MATCH/RULE/LEDGER 실시간 로그) + 12기능 체험 체크리스트
- 하단 탭(채팅/탐색/마이)으로 자유 탐색, 노쇼 시뮬레이션 포함

## 개발 메모

- 순수 정적 HTML — 빌드 단계 없음, 외부 네트워크 요청 없음(전부 클라이언트 사이드 시뮬레이션)
- 로컬 확인: 리포 루트에서 `python -m http.server 8936` → http://localhost:8936
- 디자인 토큰: 브랜드 블루 `#33549C` 계열, Pretendard/시스템 폰트 — 전 페이지 공통
- `vercel.json`의 `cleanUrls`로 `.html` 없는 경로 사용
