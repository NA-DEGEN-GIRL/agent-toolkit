# Game Visual Polish Usage Examples

## Whole-game visual improvement

```text
use game-visual-polish
지금 게임 그래픽이 별로야. 프로젝트와 실제 플레이 화면을 확인하고,
장르와 플레이 방식에 맞는 분위기를 찾아서 개선해.
게임 규칙, 조작, 밸런스는 유지해.
```

## Selected item only

```text
use game-visual-polish
플레이어의 검과 방패 디자인만 기존 게임 화풍에 맞게 개선해.
배경, 조명, 카메라, UI, 아이템 능력치와 판정은 바꾸지 마.
```

## UI only

```text
use game-visual-polish
스킬트리 화면만 게임 분위기에 맞게 개선해.
아이콘, 패널, 연결선, 타이포와 간격을 다듬되 스킬 내용과 획득 로직은 유지해.
```

## Design-only

```text
use game-visual-polish
현재 게임의 시각적 문제를 진단하고 어울리는 아트 방향을 제안해.
코드와 에셋은 수정하지 마.
```

The skill infers `game`, `scene`, `asset`, `ui`, or `design-only` scope from the request. A local asset request does not authorize global camera/lighting/theme changes. When runtime capture is available, it compares real baseline and candidate gameplay views; when unavailable, it must label visual/integration verification as unverified instead of fabricating completion.
