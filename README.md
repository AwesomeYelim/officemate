# OfficeMate — 지란지교 해커톤 2026 제출물

OfficeMate는 오피스챗에 붙는 AI 매칭 어시스턴트로, 동료 간 식사·번개 모임을 자동으로 개설·매칭·정산합니다. 이 리포는 해커톤 제출물(랜딩 데모, 사업계획서, 화면 목업, HR 콘솔 시뮬레이터)을 정적 사이트로 묶은 것입니다.

## 🌐 배포 주소

**https://officemate-five.vercel.app**

`main` 브랜치에 push하면 Vercel이 자동으로 배포합니다 (팀원 push 포함, 별도 절차 없음). 배포 상태는 [Vercel 대시보드](https://vercel.com)에서 확인.

## 페이지 목록

| 경로 | 내용 |
|---|---|
| [/](https://officemate-five.vercel.app/) | 제출물 허브 (시작 페이지) |
| [/landing](https://officemate-five.vercel.app/landing) | 랜딩페이지 + 라이브 데모 (`#demo` 앵커로 데모 섹션 진입) |
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
