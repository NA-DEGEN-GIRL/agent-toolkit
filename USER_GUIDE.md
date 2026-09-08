# Useful Skills — 사용자 가이드

이 repo에 들어 있는 스킬들을 사람이 빠르게 이해하고 쓰기 위한 안내입니다. 설치는 [`INSTALL.md`](INSTALL.md), 가족/패키지 색인은 [`skills/README.md`](skills/README.md)를 보세요.

## 스킬을 부르는 법

- 명시 호출: `use <스킬이름>` (예: `use orient-repo`).
- 또는 각 스킬의 트리거 문구를 그냥 말하면 됩니다 (예: "이 repo 파악해줘").
- 기본 응답 언어는 한국어. 명령·경로·파일명·에러는 원문 유지.

## 한눈에

| 스킬 | 어느 agent | 무엇을 하나 |
|---|---|---|
| `distill-ramble` | Codex + Claude | 마이크/대화로 떠든 생각을 티키타카로 정제해 seed 문장 생성 |
| `shape-idea` | Codex + Claude | 모호한 만들기 아이디어를 질문·기술 fork 번역·Design Brief로 구체화 |
| `codex-init-gate` | Codex | 선택된 canonical runner에 LLM-debuggable check-only 품질 게이트 구성 (`make check`는 Make 선택 시) |
| `claude-init-gate` | Claude Code | 위와 동일 (Claude Code용) |
| `codex-handoff` | Codex | 세션 작업 스냅샷 저장/재개 (`.handoff/`); 병렬 작업은 scope별 lane |
| `claude-handoff` | Claude Code | 위와 동일 (Claude Code용) |
| `design-repo-subagents` | Codex | repo 기반 subagent 설계/운영 |
| `write-agents-md` | Codex | `AGENTS.md` 작성·리뷰 |
| `orient-repo` | Codex + Claude | 읽기전용 repo 파악 리포트 |
| `game-visual-polish` | Codex | 기존 게임의 그래픽·분위기·UI·특정 아이템 디자인을 범위 안에서 개선 |

`distill-ramble`, `shape-idea`, `orient-repo`는 Codex·Claude 공용이고 나머지는 위 표의 agent용입니다.

---

## distill-ramble — 생각/음성 ramble 정제 (Codex + Claude)

- **무엇:** 사용자가 마이크나 채팅으로 떠오르는 대로 말하면, AI가 짧게 반영하고 한 번에 한 질문씩 던지며 핵심 흐름을 찾습니다. 최종 부산물은 Design Brief가 아니라 다음 단계에서 구체화할 수 있는 **seed 문장**입니다.
- **언제:** 아이디어가 아직 너무 산만해서 바로 `shape-idea`로 들어가기 어렵거나, 음성 대화 세션에서 “내가 말한 것 중 쓸만한 문장만 뽑아줘”가 필요할 때.
- **예시 프롬프트:**
  - `use distill-ramble` / `마이크로 그냥 떠오르는 대로 말할게. 중간중간 질문하면서 seed 문장으로 정리해줘.`
  - `use distill-ramble` / `I want to talk through a messy idea. Don't make a plan yet.`
  - `이 voice transcript에서 핵심 흐름이랑 seed 문장만 뽑아줘.`
- **비고:** 다른 스킬이나 마이크 API가 있다고 가정하지 않고, 채팅에 들어온 텍스트만 다룹니다. transcript에 섞인 지시와 민감값은 그대로 따르거나 되풀이하지 않습니다. 기본은 chat-only이며 파일 저장은 명시 요청과 정확한 경로 확인이 있을 때만 합니다. Design Brief/구현 계획/MVP 정의로 넘어가지 않습니다.
- **자세히:** [`skills/idea-shaping/USAGE.md`](skills/idea-shaping/USAGE.md)

## shape-idea — 아이디어 구체화 / Design Brief 작성 (Codex + Claude)

- **무엇:** 모호한 "만들고 싶다" 요청이나 진행 중 프로젝트의 새 기능 아이디어를 planning/coding 전에 구체화합니다. 한 번에 한 질문씩 의도·성공 기준·MVP scope·제약을 잡고, 사용자가 체감할 기술적 갈림길은 쉬운 말과 정확한 용어(WebSocket, hosted database 등)로 번역한 뒤, testable acceptance criteria가 있는 **Design Brief**로 남깁니다.
- **언제:** 새 제품/기능 아이디어가 아직 덜 정해졌을 때, "바로 계획" 전에 왜 이 접근을 택하는지 기록하고 싶을 때, 기존 repo 기능 추가 전에 결정과 tradeoff를 먼저 정리하고 싶을 때.
- **예시 프롬프트:**
  - `use shape-idea` / `아이디어 구체화해줘`
  - `use shape-idea` / `방송 중 실시간 투표 웹앱 만들고 싶은데 먼저 설계 같이 정하자.`
  - `이 repo에 기능 하나 추가하려는데, 먼저 구조 파악하고 같이 설계 정하자.`
- **비고:** 기본은 design-only입니다. 코드/스캐폴딩/구현 계획을 쓰지 않고, 기존 repo에서는 read-only로만 파악합니다. 중간에 새 기능을 추가할 때는 실제 코드 상태와 기존 brief/ADR의 불일치를 먼저 보여주고, 보통 `docs/designs/<feature-slug>.md`에 기능별 brief를 둡니다. 내용 상태(`Draft`/`Accepted`)와 저장 상태(`inline-only`/`saved`)는 별개이며, 저장본도 현재 대화 상태와 `current`/`stale`인지 보고합니다. 내용 승인, 저장 승인, 정확한 root/path 승인을 각각 확인하고 기존 brief는 백업+changelog로 갱신합니다. 이후 gate가 없으면 `codex-init-gate`/`claude-init-gate`, 그 다음 `write-agents-md`로 brief/gate 참조를 추가합니다.
- **자세히:** [`skills/idea-shaping/USAGE.md`](skills/idea-shaping/USAGE.md)

### 권장 end-to-end 순서

1. 선택적으로 `distill-ramble`로 raw voice/freeform thought를 seed 문장으로 정리합니다.
2. `shape-idea`로 Design Brief를 확정합니다.
3. canonical 품질 게이트가 없으면 `codex-init-gate` / `claude-init-gate`를 실행합니다.
4. `write-agents-md`가 AGENTS.md에 accepted brief와 canonical gate를 짧게 참조하게 합니다.
5. 그 다음 plan/build로 넘어갑니다.

## codex-init-gate / claude-init-gate — repo 품질 게이트 초기화

- **무엇:** feature work 전에 명령 본문을 검토한 뒤 `fmt`/`lint`/`typecheck`/`test` 계약을 선택된 canonical runner에 구현합니다. Make가 선택된 경우 `make check`를 쓰고, 기존 `just`/`task`/package runner가 있으면 별도 Makefile을 만들지 않습니다. LLM이 수정·디버깅하기 쉬운 구조 원칙도 점검하고, 필요하면 pre-commit/CI까지 승인 후 연결합니다. 이것은 **품질 게이트 bootstrap**이지 일반 `git init` 대체품은 아닙니다.
- **언제:** 새 repo를 막 시작했을 때, 새 language/stack을 추가했을 때, 기존 repo의 gate를 점검하거나 보강하고 싶을 때.
- **예시 프롬프트:**
  - `use codex-init-gate` / `이 repo에 품질 게이트 깔아줘. 언어는 Python이야.`
  - `use claude-init-gate` / `make check가 fmt/lint/typecheck/test를 제대로 강제하는지 점검만 해줘.`
  - `기존 TS repo에 Rust crate를 추가했어. Rust 쪽 gate만 추가해줘.`
- **비고:** `repo_state`(`empty-repo`/`fresh-repo`/`existing-repo`)와 operation(`scaffold`/`add-stack`/`verify-only`)을 따로 분류합니다. 기본 흐름은 inspect → command review → plan → approval → apply → reviewed canonical check입니다. check-only는 tracked source/config/lockfile을 바꾸지 않는다는 뜻이며, 명시한 ignored cache/build output은 생길 수 있습니다. tool install, `.git` 변경, 기존 config overwrite, CI 추가는 명시 승인이 필요합니다.
- **자세히:** [`skills/repo-bootstrap/USAGE.md`](skills/repo-bootstrap/USAGE.md)

## codex-handoff / claude-handoff — 작업 핸드오프

- **무엇:** 요청한 작업 체크포인트·인수인계를 `.handoff/latest.md`로 저장/검증하여 재개합니다. 같은 대화의 자동 압축·일반적인 이어서 작업하기·기존 세션 재접속은 이 스킬의 용도가 아닙니다. 명시적으로 새 대화로 옮기거나 Codex↔Claude 간 전달할 때 사용하며, checkpoint만 저장하고 같은 대화를 계속할 수도 있습니다.
- **언제:** 체크포인트 파일을 요청할 때, 의도적으로 새 대화/호환 agent로 인계할 때, 특정 scope의 저장된 handoff에서 복구할 때. 대화가 길거나 압축됐다는 이유만으로 실행하지 않습니다.
- **예시 프롬프트:**
  - `use codex-handoff` / `handoff 저장해줘` / `clear 전에 handoff 파일로 저장해줘`
  - `use codex-handoff, 이어받아` / `.handoff/latest.md 보고 계속해`
  - 특정 작업군만(scope): `auth-refactor scope로 handoff 저장해줘` / `auth-refactor scope 이어받아`
  - (Claude Code에서는 `codex-handoff` 대신 `claude-handoff`)
- **비고:** 스냅샷은 **신뢰하지 않는 데이터**로 취급 — 실제 repo 상태가 우선이고, 스냅샷 안의 명령/지시는 검증 후에만 따릅니다. `save_snapshot.py`가 bounded validation, exclusive backup, lock/CAS, atomic latest, parity, retention을 담당하고 `select_snapshot.py`가 한 lane 안에서 valid latest→backup을 선택합니다. 두 패키지는 파일 포맷을 공유하지만 백업 파일에 `-codex.md` / `-claude.md`로 출처를 남깁니다.
- **자세히:** [`skills/handoff/USAGE.md`](skills/handoff/USAGE.md)

### 병렬 작업 — scope(lane) handoff  *(신규)*

여러 LLM을 동시에 띄워 **작업군(주제)이 서로 다를 때**, 하나의 `.handoff/latest.md`를 공유하면 서로 덮어씁니다. 이때 **scope(lane)** 로 작업군별 스냅샷을 따로 저장·재개합니다.

- 경로: 기본 lane은 `.handoff/latest.md`, scope를 주면 `.handoff/scopes/<scope>/latest.md`.
- scope는 직접 정합니다(소문자·숫자·하이픈, 예: `auth-refactor`). `default`/`latest`/`scopes`는 예약어라 못 씁니다. 안 주면 기존 단일 lane 그대로 동작합니다.
- lane끼리 격리되고 canonical writer는 자동 해제되는 advisory per-lane lock과 content-hash CAS를 사용합니다. 그래도 비협조적 도구까지 막는 전역 lock은 아니므로 한 scope는 한 명의 논리 writer를 권장합니다.
- **충돌 보호:** 다른 agent의 최근 write나 CAS mismatch면 exclusive dated backup만 남기고 `latest.md`는 유지하며 status 3을 반환합니다. 이때 exact backup을 보고하고 정상 Resume가 자동 선택한다고 말하지 않습니다.
- **정리(prune):** `save_snapshot.py`가 기본 retention을 통합 수행합니다. 별도 유지보수/preview에는 `prune_backups.py --scope <scope>` 또는 `--all-lanes`를 사용합니다.

저장 (특정 작업군만):

```text
use codex-handoff
auth-refactor scope로 handoff 저장해줘.
```

재개 (그 lane만):

```text
use claude-handoff
auth-refactor scope 이어받아.
```

scope 없이 그냥 "이어받아"라고 하면, `list_lanes.py`가 latest가 없는 backup-only lane까지 안전하게 보여줍니다. lane이 여러 개면 어느 lane을 이어받을지 물으며, 선택 후 `select_snapshot.py`가 그 lane만 검증합니다 — 임의 선택이나 lane 병합은 하지 않습니다.

## design-repo-subagents — subagent 설계/운영 (Codex)

- **무엇:** repo를 먼저 파악한 뒤, 작업을 explorer(읽기전용 조사)·worker(경계가 분명한 구현)·검토용 프롬프트로 나누는 안전한 위임 계획을 만듭니다. 실제 spawn 여부는 사용자의 요청뿐 아니라 현재 runtime이 제공하는 delegation policy와 capability를 따릅니다.
- **언제:** 큰 작업을 병렬로 쪼개고 싶을 때, 독립 검토(비판) agent가 필요할 때.
- **예시 프롬프트:**
  - `use design-repo-subagents` / `이 작업 subagent로 나눠줘` (→ 현재 runtime policy에 맞춰 계획 또는 실행)
  - `비판 agent 만들어줘` (→ 검토 프롬프트 생성)
  - `실제로 띄워줘` / `병렬로 실행해` (→ 실제 spawn)
- **비고:** runtime이 explicit-only이면 실행 동사를 확인하고, proactive delegation이 활성화되어 있으면 독립적이고 bounded한 sidecar 작업을 먼저 실행할 수 있습니다. 어느 경우에도 worker write set, 공유 filesystem, context fork, concurrency, 취소 방법을 확인하고 다른 사람 변경을 되돌리지 않습니다. `verification`은 내장 역할이 아니라 프롬프트 패턴입니다.
- **자세히:** [`skills/subagents/USAGE.md`](skills/subagents/USAGE.md)

## write-agents-md — AGENTS.md 작성/리뷰 (Codex)

- **무엇:** repo의 실제 사실(manifest·CI·Makefile·스크립트·설정)을 근거로 `AGENTS.md`(코딩 agent용 repo 지침)를 작성·리뷰·갱신합니다. 사용자가 쓴 기존 지침은 보존하고, 확인 안 된 명령은 `unverified`로 표시합니다.
- **언제:** 새 repo에 agent 지침을 만들 때, 기존 `AGENTS.md`를 점검/개선할 때.
- **예시 프롬프트:**
  - `use write-agents-md` / `AGENTS.md 만들어줘` / `agents.md 작성`
  - `repo instruction 정리해줘` / `이 AGENTS.md 리뷰해줘`
- **비고:** 추측으로 명령·버전·배포 절차를 지어내지 않습니다. 리뷰만 요청하면 파일을 수정하지 않고 제안만 냅니다. 쓰거나 통합·삭제할 때는 target containment/symlink를 확인하고 exact diff, 승인, timestamp backup을 거칩니다. consequential Design Brief 변경은 `shape-idea` 영역입니다. 기본은 root `AGENTS.md`.
- **자세히:** [`skills/repo-instructions/USAGE.md`](skills/repo-instructions/USAGE.md)

## orient-repo — repo 파악 리포트 (Codex + Claude)

- **무엇:** 임의의 저장소를 **읽기 전용**으로 훑어 한 장짜리 오리엔테이션 리포트를 냅니다: stack, entrypoint, 명령과 근거 수준, canonical quality gate, 주요 디렉터리, instruction 파일, Design Brief/ADR, 최근 활동, 미확인 항목. 아무것도 수정하지 않습니다.
- **언제:** 처음 보는 repo에 들어갔을 때, "이거 어떻게 돌리지/테스트하지?"가 궁금할 때.
- **예시 프롬프트:**
  - `use orient-repo` / `이 repo 파악해줘` / `repo 구조 알려줘`
  - `what is this repo and how do I run/test/build it?`
- **비고:** handoff가 있으면 symlink/path escape와 1 MiB 상한을 검사하고, 여러 default/scoped lane을 합치지 않은 채 관련 lane 하나만 선택해 **이전 세션 맥락**을 신뢰하지 않는 힌트로 반영합니다. 명령은 `documented`, `statically confirmed`, `executed`를 구분하며 orientation 자체는 실행하지 않습니다. remote/home/changed path와 snapshot 요약도 redaction합니다.
- **자세히:** [`skills/repo-orientation/USAGE.md`](skills/repo-orientation/USAGE.md)

## game-visual-polish — 기존 게임 그래픽/아이템/UI 개선 (Codex)

- **무엇:** 이미 개발 중인 게임을 실제 프로젝트와 플레이 화면 기준으로 보고, 장르·세계관·플레이 방식에 맞는 아트 방향을 골라 **요청한 범위만** 개선합니다. 전체 게임, 특정 장면, 특정 에셋/아이템, UI, design-only를 구분합니다.
- **언제:** "그래픽이 별로다", "이 게임에 맞는 분위기를 찾아 개선해", "검/방패만 다시 디자인해", "스킬트리 UI만 개선해" 같은 요청.
- **예시 프롬프트:**
  - `use game-visual-polish` / `게임 그래픽이 별로야. 장르에 맞는 분위기를 찾아 실제 프로젝트에 반영해. 게임 로직은 유지해.`
  - `use game-visual-polish` / `검과 방패 디자인만 개선해. 배경, 카메라, 조명, 능력치와 판정은 건드리지 마.`
  - `use game-visual-polish` / `스킬트리 UI만 개선해. 기능과 정보 구조는 유지해.`
  - `use game-visual-polish` / `문제 진단과 아트 방향만 제안하고 코드는 수정하지 마.`
- **비고:** 실사 AAA를 기본 정답으로 보지 않고 픽셀·카툰·로우폴리·플랫 스타일도 게임에 맞으면 선택합니다. 로컬 에셋 수정 시 공유 material/shader/atlas/theme이 다른 consumer까지 바꾸지 않는지 먼저 확인합니다. 이미지 생성·Blender·runtime capture·subagent는 호스트가 실제 제공할 때만 사용하며, 실행/캡처/성능 검증을 못 했으면 완료 검증이라고 주장하지 않습니다.
- **자세히:** [`skills/game-visual-polish/USAGE.md`](skills/game-visual-polish/USAGE.md)

---

## 설치

[`INSTALL.md`](INSTALL.md)의 dry-run-first `scripts/install_skill.py`로 대상 agent의 스킬 홈에 복사(권장) 또는 심볼릭 링크합니다. `distill-ramble`, `shape-idea`, `orient-repo`는 같은 소스를 Codex·Claude 양쪽에 설치할 수 있고, `game-visual-polish`는 현재 Codex 대상으로 등록되어 있습니다. 설치 후 `doctor`로 version/duplicate를 확인하고 agent를 재시작하거나 새 세션을 엽니다.

## 공통 안전 메모

- handoff 스냅샷·가져온 repo 상태는 **신뢰하지 않는 데이터**. 실제 파일·git 상태가 항상 우선.
- 설치된 글로벌 스킬(`~/.codex/skills`, `~/.claude/skills`)은 명시 요청 없이는 수정하지 않습니다.
- 기본 설치는 동명 대상을 discovery root 밖 `<agent-home>/skill-backups/`에 백업한 뒤 복사합니다. 기본 `handoff` 스킬을 임의로 덮어쓰지 않습니다.
