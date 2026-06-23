# PullStack

📖 **언어:** [English](README.md) · [한국어](README.ko.md)

**AI 보조 코드를 출시하는 팀을 위한 GitHub PR 협업-리스크 분석기.**

PullStack은 **코드 생성기가 아니며**, **범용 AI 리뷰어도 아닙니다.** Claude Code,
Codex, Cursor 같은 도구를 쓰는 팀을 위한 **머지 리스크 분석기**입니다. AI 덕분에
크고 빠르게 움직이는 PR을 만들기 쉬워졌습니다 — PullStack은 협업·머지 순서상의
리스크를 드러내어 그런 PR을 *안전하게* 머지하도록 돕습니다.

다음과 같은 질문에 답합니다:

- 이 PR이 선언한 범위(scope) 밖으로 조용히 벗어났는가?
- 다른 팀이 의존하는 **공유 계약(shared contract)** (타입 / API / 스키마)을 바꿨는가?
- 코드는 바꿨는데 **테스트는 없는가**?
- 열려 있는 다른 PR과 **파일이 겹치는가** (그리고 무엇을 먼저 머지해야 하는가)?
- **보호 경로(protected path)** (인증, 보안, 마이그레이션, CI)를 건드렸는가?
- 리뷰어가 실제로 **집중해서 봐야 할 곳**은 어디인가?
- 더 작은 **스택형 PR로 분할**해야 하는가?

## 동작 방식 — 하이브리드 분석

PullStack은 두 개의 레이어를 결합합니다:

1. **결정론적 규칙 엔진** (항상 실행, 네트워크·LLM 불필요): 변경 파일, diff 크기,
   공유 계약 글롭, 보호 경로, 테스트 누락, 선언 범위 위반, 코드 오너 매칭, 열린 PR
   파일 중첩.
2. **Claude 시맨틱 레이어** (선택): PullStack이 프롬프트
   (`.pullstack/claude-analysis-prompt.md`)를 생성하면, Claude Code Action 또는
   Claude Code를 직접 실행하는 사람이 이를 사용해 범위 드리프트, 계약 변경, 리뷰
   포커스, 분할 권고, 머지 판단을 내립니다. 그 결과
   (`.pullstack/semantic-analysis.json`)가 최종 리포트에 병합됩니다.

> 이 MVP는 Anthropic API를 **직접 호출하지 않습니다.** 프롬프트를 만들어내고, 별도의
> Claude Code 단계가 작성한 JSON을 소비합니다. 덕분에 도구가 결정론적이고, 실행
> 비용이 낮으며, CI에 넣기 쉽습니다.

## MVP 범위

- 로컬과 GitHub Actions의 pull request에서 실행됩니다.
- `.pullstack/report.json`, `.pullstack/report.md`,
  `.pullstack/claude-analysis-prompt.md`를 생성합니다.
- 단일 PR 댓글을 게시/갱신합니다(중복 방지).
- SaaS 대시보드 없음, 데이터베이스 없음, LLM API 호출 없음. 그냥 쓸 만한 POC입니다.

## 산출물

| 파일 | 설명 |
|---|---|
| `.pullstack/report.json` | 머신 판독용 전체 리포트(발견 사항, 점수, 권고). |
| `.pullstack/report.md` | 사람이 읽는 PR 댓글(`<!-- pullstack-report -->` 마커 포함). |
| `.pullstack/claude-analysis-prompt.md` | Claude Code가 시맨틱 분석을 생성하기 위한 프롬프트. |
| `.pullstack/semantic-analysis.json` | *(입력)* 존재하면 리포트에 병합됨. |

## 설치 & 로컬 사용법

```bash
npm install
npm run build
npm test

# 현재 브랜치를 origin/main과 비교 분석
npm run analyze -- --base origin/main --head HEAD

# 또는 빌드된 CLI / npx 로
node dist/cli.js analyze --base origin/main --head HEAD
npx pullstack analyze --base origin/main --head HEAD
```

### CLI 옵션

```bash
pullstack analyze \
  --base origin/main \   # 기본값: $GITHUB_BASE_REF (origin/<ref> 형태) 또는 origin/main
  --head HEAD \          # 기본값: HEAD
  --out-dir .pullstack \ # 기본값: .pullstack
  --config .pullstack.yml \ # 기본값: .pullstack.yml 이 있으면 사용, 없으면 내장 기본값
  --comment false        # 기본값: GitHub Actions PR + GITHUB_TOKEN 일 때만 true
```

diff 수집에 실패하면(예: `origin/main` 이 없을 때) PullStack은 `--base` 전달 방법을
안내하고, CI에서는 `fetch-depth: 0` 을 쓰라고 알려줍니다.

## GitHub Actions 사용법

[`.github/workflows/pullstack.yml`](.github/workflows/pullstack.yml) 을 복사하세요.
이 워크플로는:

1. `fetch-depth: 0` 으로 체크아웃하고,
2. Node 20 셋업 → 설치 → 빌드 → 테스트하고,
3. `pullstack analyze` 를 실행하고,
4. 리포트를 PR에 댓글로 남기며(HTML 마커로 중복 방지),
5. `report.md` / `report.json` / `claude-analysis-prompt.md` 를 아티팩트로 업로드합니다.

필요한 권한:

```yaml
permissions:
  contents: read
  pull-requests: write
```

## Claude Code 시맨틱 분석 사용하기

결정론적 레이어만으로도 충분히 유용합니다. 시맨틱 레이어를 추가하려면:

1. `pullstack analyze --comment false` 실행 → `claude-analysis-prompt.md` 생성.
2. 그 프롬프트로 Claude Code 실행 → `.pullstack/semantic-analysis.json` 작성.
   - CI: [`.github/workflows/pullstack-claude.yml`](.github/workflows/pullstack-claude.yml)
     참고 (**예시** — Claude Code Action 단계를 사용 중인 버전에 맞게 조정).
   - 로컬: `.pullstack/claude-analysis-prompt.md` 를 Claude Code에서 열어 JSON을
     작성하게 합니다.
3. `pullstack analyze --comment true` 를 다시 실행 → 시맨틱 결과를 병합하고 최종
   댓글을 게시합니다.

시맨틱 JSON 스키마는 생성된 프롬프트 안에 문서화되어 있습니다. 파일이 존재하지만
유효하지 않으면, PullStack은 낮은 심각도의 경고 발견 사항을 추가하고 계속 진행합니다 —
잘못된 시맨틱 JSON 때문에 전체 실행이 실패하는 일은 없습니다.

## `.pullstack.yml` 설정

설정은 **선택**입니다. 없으면 합리적인 기본값이 적용됩니다.
[`.pullstack.example.yml`](.pullstack.example.yml) 을 `.pullstack.yml` 로 복사하세요.

| 키 | 의미 |
|---|---|
| `project.name` / `project.default_base` | 표시 이름과 폴백 base ref. |
| `risk.large_pr_*` | "대형 PR" 규칙의 임계값. |
| `shared_contracts` | 변경 시 다른 팀/코드에 고위험인 글롭. |
| `protected_paths` | 고민감 글롭(인증, 보안, 마이그레이션, 인프라, CI). |
| `test_patterns` | 무엇을 테스트 파일로 볼지(테스트 누락 규칙). |
| `owners[].paths` / `owners[].reviewers` | CODEOWNERS 유사 리뷰어 제안. |
| `scope.declared_allowed_paths` | 설정 시, 이 밖의 변경은 드리프트로 표시. |
| `scope.declared_forbidden_paths` | 이 경로를 건드리면 표시(critical). |

글롭은 [minimatch](https://github.com/isaacs/minimatch) 문법을 사용합니다(`dot: true`).

## 리스크 점수

발견 사항은 가중치 점수를 더합니다(최대 100점):

| 신호 | 점수 |
|---|---|
| 대형 PR | +10 (임계값을 크게 초과하면 +20) |
| 공유 계약 변경 | +25 |
| 보호 경로 변경 | +25 (보안/마이그레이션/CI/인프라는 +40) |
| 테스트 누락 | +15 |
| 범위 허용-경로 위반 | +20 |
| 범위 금지-경로 위반 | +35 |
| PR 중첩 | PR당 +10, 최대 +30 |
| 시맨틱 high / critical 발견 | +15 / +25 |

리스크 등급: `0–24 low`, `25–49 medium`, `50–74 high`, `75–100 critical`.

머지 권고: `low → safe_to_merge`, `medium/high → needs_review`,
`critical → blocked`. 오버라이드는 **상향만** 가능합니다:

- 보호 경로 **그리고** 테스트 누락 → `blocked`
- 공유 계약 **그리고** 테스트 누락 → 최소 `needs_review` (점수 ≥ 50 이면 `blocked`)
- 금지-범위 위반 → `blocked`
- Claude 시맨틱 `merge_recommendation` 은 상향만 가능하며 절대 하향하지 않음.

## 보안 참고사항

- **포크 PR:** GitHub은 포크 PR에 읽기 전용 토큰을 줍니다. PullStack은 포크 PR을
  감지해 **댓글을 건너뛰고** 대신 리포트를 아티팩트로 업로드하므로, 권한 때문에
  실패하지 않습니다. 동일 저장소 PR에는 `pull-requests: write` 를 유지하세요.
- PullStack은 **자기 자신의** 스크립트만 실행합니다. 분석 대상 PR의 코드를 실행하지
  않으며, `git` 과 GitHub API로 diff만 읽습니다.
- 신뢰할 수 없는 PR 코드를 체크아웃하는 `pull_request_target` 을 추가하지 마세요. 이
  워크플로는 일반 `pull_request` 를 사용합니다.
- 생성된 프롬프트에는 diff의 일부(잘린 슬라이스)가 포함됩니다. 저장소의 diff에 비밀
  정보가 있다면 프롬프트/아티팩트도 그에 맞게 취급하세요.

## 한계

- 시맨틱 레이어는 별도의 Claude Code 단계가 필요합니다. 없으면 리포트는 결정론적
  레이어만 사용합니다(그래도 유용함).
- PR 중첩 분석에는 GitHub 토큰 + PR 컨텍스트가 필요하며, 없으면 우아하게 생략됩니다.
- 글롭 기반 계약/오너 탐지는 휴리스틱입니다 — 설정으로 조정하세요.
- 프롬프트에 포함되는 diff는 매우 큰 PR의 경우 약 60 KB에서 잘립니다.
- 영속성/이력 없음. 각 실행은 무상태(stateless)입니다.

## 로드맵

- 상위 발견 사항에 대한 인라인 파일/라인 주석(리뷰 코멘트).
- (인라인 `owners` 에 더해) CODEOWNERS 파일 파싱.
- 열린 모든 PR을 가로지르는 머지 순서/스택형 PR 그래프.
- 점수 가중치 설정 및 팀별 정책 프리셋.
- 완전 자동 시맨틱 분석을 위한 선택적 Anthropic API 직접 호출 모드.

## 라이선스

MIT
