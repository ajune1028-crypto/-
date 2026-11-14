# hamkke (가칭) — 친구와 링크로 같이 쓰는 방 앱

친구를 링크로 방에 초대해서, 방 안의 모든 것을 실시간으로 같이 한다. 앱 이름은 아직 없고 코드 이름이 hamkke다.
안드로이드 폰이 첫 대상이고, 링크만 있으면 아이폰·아이패드·PC 브라우저에서도 된다. 로그인은 없다. 링크가 곧 방이고, 방마다 별명과 색이 있고, 숫자 5자리 개인 식별 코드로 다른 기기에서도 같은 사람이 된다.
Claude Code는 이 파일을 세션마다 읽는다. 사람이 읽어도 된다.

## 지금 어디까지 왔나

- **만들어 둔 것**: 조각 1의 1차. 홈(일상/창작 반반), 방 만들기·입장·초대 링크·연결 진단, 일상 텍스트 방(한 장의 종이를 같이 쓴다: 어절마다 사람 색, 색 섞기, 시간 표지, 날짜별 장, 실행취소), 라이트·다크, 파란 유리(glass) 디자인.
- **올라가 있는 곳**: Claude 안의 시험판 페이지(아티팩트) https://claude.ai/artifact/WjvZ92AeB5AvL1E7FWngef . Claude 계정으로 공유받은 사람만 열 수 있다.
- **다음**: 노래 만들기 방. 설계는 있고(`docs/superpowers/specs/2026-11-10-song-room-design.md`) 코드는 아직 없다. 0차(음 인식 실험, 합성 시험음으로) → 1차(혼자 쓰는 방) → 2차(같이 쓰기) 순서.
- **그다음**: 텍스트 방 2차(배경, 반짝이는 글자, 표시·낙서, 잠금, 비밀번호 화면) → 사진 방·통합 방 → 글쓰기 → 화이트보드. 중간에 실제 배포(GitHub Pages + Supabase. 사용자가 무료 계정 둘을 만들어야 한다)와 스토어 출시.
- **브랜치**: 모든 작업이 `feat/text-room-phase1`에 있다. 원격 저장소가 없고 아무것도 합치거나 올리지 않았다. 갈라져 나온 곳은 `specs/2026-11-10-design`.

## 사용자와 일하는 법 (가장 중요)

- 한국어로 답한다. 사용자는 구어체·음성 받아쓰기로 말하고(오타와 반복이 많다) 보통 폰으로 읽는다. 결론부터, 짧게.
- 사용자의 말: "나한테 맞냐고 묻지 말고, 이 방향이 본질에 맞는지, 내가 한 모든 말과 들어맞는지 스스로 계속 확인해라. 알아서 다 해라." 세부는 묻지 말고 정한다. 정한 것은 `docs/superpowers/plans/2026-11-12-text-room-phase1-rulings.md`처럼 한 줄씩 남긴다. 되돌릴 수 없는 일(삭제, 푸시, 배포, 계정 만들기)만 먼저 묻는다.
- 기준은 사용자의 원문이다: `docs/superpowers/source/2026-11-10-original-idea.txt`, 같은 폴더의 참고 이미지 3장, 그리고 그 뒤 대화에서 한 말을 옮겨 둔 `user-messages.md`(최근 것은 원문, 앞선 것은 발췌). 한 조각이 끝날 때마다 원문과 개요 설계 8절의 체크리스트에 대조한다.
- 사용자가 폰에서 직접 눌러 본다. "된다"고 말하기 전에 실제로 돌려 본다. 11월 13일에 "방이 안 만들어진다"는 사고가 있었다. 테스트가 `el.click()`으로 눌러서 가려진 입력칸을 못 잡았고, 원인은 CSS 클래스 이름 충돌이었다(rulings의 "The 13 November outage").

## 명령

Node.js 22 이상이면 된다. 외부 패키지가 없어서 `npm install`이 필요 없다.

```
npm test                                    # node --test. 단위 테스트 107개
npm run dev                                 # http://127.0.0.1:8000/index.html 에 소스를 띄운다 (npm run dev -- 8123 처럼 포트 지정)
node tools/e2e.mjs [이름 일부…] [--dist]    # 헤드리스 Chrome 화면 시나리오 57개. --dist는 먼저 bundle을 돌려야 한다
node tools/bundle.mjs [--share-base=https://…]   # dist/index.html 한 파일로 묶는다(시험판용)
```

- 화면 시나리오는 Chrome이나 Edge가 필요하다. 자동으로 찾고, 못 찾으면 `CHROME_BIN`에 실행 파일 경로를 넣는다. macOS·Windows 경로는 목록만 테스트했고 실제 실행은 Linux에서만 해 봤다.
- 로컬에서 두 사람 흉내: 같은 주소로 탭 두 개를 `?dev=a`, `?dev=b`로 연다(기기 둘). 같은 브라우저 안에서 BroadcastChannel로 서로 보인다. 한쪽에서 방을 만들고 초대 창의 방 코드를 다른 쪽 홈의 "코드로 들어가기"에 넣는다. `?ns=이름`은 저장 공간을 분리한다(테스트용).
- `dist/`는 git에 없다. 지금 올라가 있는 시험판과 똑같은 파일은 `node tools/bundle.mjs --share-base=https://claude.ai/artifact/WjvZ92AeB5AvL1E7FWngef`로 만든다. sha256이 `b18326f7704af883c2a036feb3ff9e01664c6a6b0ae795e0e9410f75c012c84a`이면 같은 파일이다.
- Claude 없이 모양만 보려면 `dist/index.html`을 브라우저로 열면 된다. 방은 그 기기에만 생긴다.

## 구조

`src/`는 의존 방향이 ui → sync → core다. core는 화면도 네트워크도 모른다.

- `core/`: `crdt.js`(글자 목록을 합치는 규칙 RGA와 시계), `edit.js`(입력을 op로, 되돌리기용 역 op), `paint.js`(어절 색, 색 섞기, 명암비), `room.js`(방 정보·사람·비밀번호·코드 검사, `roomLink`), `time.js`(날짜와 시간 표지), `undo.js`(내 단계만 쌓는 스택)
- `sync/`: `transport.js`(전송 약속과 Emitter), `local.js`(한 브라우저 안: localStorage + BroadcastChannel. 테스트와 "이 기기만" 방), `claude.js`(시험판: Claude 페이지의 저장소와 실시간 채널), `session.js`(방 하나를 연 화면. 내 변경을 먼저 적용하고, 못 보낸 것은 기기에 쌓았다가 다시 보내고, 받은 기록을 합친다)
- `ui/`: `dom.js`(작은 도우미: `h()`, 아이콘, 시트, 토스트. 글자는 항상 텍스트로 넣는다), `home.js`, `join.js`, `room-shell.js`(방의 공통 틀, 설정, 초대, 연결 진단), `text-room.js`, `editor.js`(그려진 층 `.draw` 아래에 투명한 `textarea.typing`), `theme.css`, `theme.js`
- `identity.js`(이 기기가 기억하는 것), `main.js`(시작: 전송을 고르고 홈이나 방을 보여 준다. `window.__app`은 테스트가 쓴다)

핵심 약속: 모든 변경은 op 하나이고, op는 어떤 순서로 몇 번 받아도 결과가 같다. 그래서 서버는 저장하고 전달만 하면 된다. 새 방 종류(노래, 사진…)도 같은 방식으로 얹는다. 앱 본체는 `Transport` 약속만 알고, 실제 배포에서는 `sync/supabase.js` 하나를 더하면 된다.

## 시험판(Claude 안의 페이지)이라서 생기는 제약. 코드에 이미 반영돼 있다

- 페이지는 막힌 틀 안에서 돈다: `alert/confirm/prompt` 없음, 마이크·카메라 없음, 서비스 워커 없음, `localStorage`가 던질 수 있음, 클립보드는 클릭 안에서만, `navigator.share` 거부, 주소는 평범한 `#이름` 해시만 통과, 다른 호스트로의 fetch·WebSocket 차단.
- 공유 저장소는 문서 하나 256 KiB, 전체 25,000개라서 기록을 묶음 문서로 모은다. **주인과 이메일로 초대된 편집자만 쓸 수 있고, 링크로만 본 사람은 읽기만 된다.** 실시간 채널은 이벤트 4 KiB, 초당 약 40개이고 주제를 `interact`로 열어야 한다. `claude.use()`는 10초 뒤에 null을 줄 수 있다.
- 그래서 저장소가 대답하지 않으면 그 기기에만 방을 만든다("이 기기만"). "친구 누구나 링크로"는 실제 배포 단계에서만 된다.
- 시험판 다시 올리기는 아티팩트 도구가 있는 claude.ai 대화에서 한다(`mcp__claude-artifacts__publish_files`, slug `f0d7436c-510d-4c4a-be1a-680ce3cfc39c`, 지금 버전 `1794580122-d96e`, 올릴 파일 `dist/index.html`). 로컬 Claude Code에 그 도구가 없으면 `dist/index.html`을 만들어 두고 claude.ai 대화에서 올려 달라고 한다.

## 이 프로젝트의 규칙

- 실패하는 테스트를 먼저 쓰고, 실패하는 것을 본 다음에 고친다. 버그는 원인(root cause)을 찾고 재현하는 테스트를 먼저 쓴 뒤에 고친다. 증상만 가리는 수정은 하지 않는다.
- 끝났다고 말하기 전에 실제로 돌린다: `npm test`, `node tools/e2e.mjs`, 묶음 파일은 `--dist`로 한 번 더.
- 화면 시나리오는 실제 탭(브라우저의 hit test)으로 누른다. `el.click()`과 스크립트 포커스는 무엇이 가리는지 못 잡는다.
- 폼 칸(`.input`)과 글 쓰는 층(`.typing`)의 CSS는 절대 섞지 않는다.
- `core/paint.js`의 `INK`/`PAPER` 값은 `theme.css`의 `--ink`/`--paper`와 같아야 한다(시나리오가 검사한다). 글자는 모든 배경에서 명암비 4.5:1 이상.
- 외부 라이브러리 없이 간다(처음에 패키지 설치가 막힌 환경이어서 시작한 방식이다). 바꾸려면 이유를 rulings에 적는다.
- 코드 주석은 영어, 사용자에게 보이는 글자와 문서는 한국어. 커밋 제목은 `feat:` `fix:` `docs:`로 시작한다.
- 이 프로젝트는 superpowers 플러그인의 절차(brainstorming → writing-plans → executing-plans → test-driven-development → verification)로 만들어 왔다. 설치돼 있으면 그대로 쓰고, 없으면 위 규칙만 지켜도 된다.
- 사용자의 이메일 같은 개인 정보를 외부 서비스에 보내지 않는다. 비밀번호와 키는 코드에 넣지 않는다.

## 문서 (이 순서로 읽는다)

1. `docs/superpowers/source/`: `2026-11-10-original-idea.txt`(사용자 원문), 참고 이미지 3장, `user-messages.md`(그 뒤 대화에서 한 말). 저장소를 공개로 올리기 전에는 이 폴더를 공개해도 되는지 사용자에게 먼저 묻는다.
2. `docs/superpowers/specs/2026-11-10-app-overview-design.md`: 전체 결정, 공통 규칙, 8절 기능 체크리스트, 9절 가정
3. `docs/superpowers/specs/2026-11-10-foundation-text-room-design.md`: 바탕과 텍스트 방(전송 약속은 6.4절)
4. `docs/superpowers/specs/2026-11-10-song-room-design.md`: 다음에 만들 노래 방
5. `docs/superpowers/plans/2026-11-12-text-room-phase1.md`(1차 구현 계획, 끝남)와 `…-rulings.md`(만들면서 내린 판단 전부, 13일 사고, 미룬 사소한 문제)

## 알려진 빈틈

- 저장소 쓰기가 늦게 도착하면 같은 이름의 빈 방이 다른 기기 목록에 남을 수 있다.
- 홈의 연결 진단이 방이 없을 때 "실시간 채널 none"으로 보인다.
- 파란 버튼 윗부분 명암비가 4.2:1이다(글자 자리는 4.6:1 이상).
- 저장소를 거부하는 틀에서는 새로고침하면 "내가 누구인지"를 잊는다(개인 코드를 정한 사람은 괜찮다).
- 실제 안드로이드 폰의 한글 입력(조합)과 화면은 사람이 직접 확인하지 않았다. 자동 테스트는 조합 이벤트를 흉내 낼 뿐이다.
