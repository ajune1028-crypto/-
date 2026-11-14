# 공개 주소 만들기: Claude 없이 어떤 브라우저에서든 방 링크로 같이 쓰기

이 앱은 공개 주소에서 Claude와 상관없이 돈다. 크롬, 삼성 인터넷, 사파리, PC 브라우저 어디서든 방 링크만 열면 같은 방에 들어온다. 필요한 것은 두 가지다.

1. **방 서버**: 구글 Firebase의 Realtime Database(무료). 방의 기록이 여기에 모인다.
2. **공개 주소**: GitHub Pages(무료). 앱 파일이 여기서 열린다.

둘 다 저장소 주인이 한 번만 설정하면 된다. 계정이 필요한 일이라 Claude가 대신 만들 수 없다.

## 1. 방 서버 만들기 (구글 계정, 5분)

1. https://console.firebase.google.com 에 구글 계정으로 들어간다.
2. **프로젝트 만들기** → 이름은 `hamkke`처럼 아무거나 → Google 애널리틱스는 꺼도 된다 → 만들기.
3. 왼쪽 메뉴 **빌드 → Realtime Database** → **데이터베이스 만들기**.
   - 위치: **싱가포르 (asia-southeast1)**. 한국에서 가장 가깝다.
   - 보안 규칙: **잠금 모드로 시작** → 사용 설정.
4. 위쪽 **규칙** 탭 → 있는 내용을 모두 지우고 이 저장소의 `docs/firebase-rules.json` 내용을 그대로 붙여 넣기 → **게시**.
5. **데이터** 탭 맨 위에 보이는 주소를 복사한다. 이런 모양이다:
   `https://hamkke-xxxxx-default-rtdb.asia-southeast1.firebasedatabase.app`
   이 주소는 비밀이 아니다. 방을 지키는 것은 규칙과 방 링크다.

## 2. 앱에 서버 주소 넣기

둘 중 하나:

- **Claude에게 주소를 보낸다.** Claude가 넣고 다시 올린다.
- 직접 넣기: GitHub 저장소 → **Settings → Secrets and variables → Actions → Variables 탭 → New repository variable** → 이름 `HAMKKE_SERVER`, 값은 1단계 5번의 주소.

## 3. 공개 주소 켜기 (GitHub Pages)

1. GitHub 저장소 → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. 작업 브랜치가 `main`에 합쳐지면 자동으로 테스트하고 올린다. 몇 분 뒤 `https://ajune1028-crypto.github.io/-/` 가 열린다.

## 이렇게 되면

- 방을 만들고 초대 링크를 보내면, 받은 사람은 어떤 브라우저에서든 그 링크로 같은 방에 들어온다. Claude 계정은 필요 없다.
- https 주소라서 **앱 안 녹음(마이크)** 도 된다. 폰 녹음 앱과 파일 가져오기도 된다.
- 서버는 방 목록을 아무에게도 보여 주지 않는다. **링크나 방 코드를 아는 사람만** 들어온다. 방 id는 12글자 무작위라서 짐작할 수 없다.
- 기록은 지울 수도 덮어쓸 수도 없게 규칙이 막는다. 잘못 쓴 것은 앱 안의 실행취소로 되돌린다.
- 인터넷이 끊겨도 쓰던 것은 기기에 남았다가 다시 이어지면 보내진다.

## 아직 안 되는 것

- 녹음 원본 파일은 아직 녹음한 기기에만 있다. 친구 기기는 같은 음을 피아노로 듣는다(음표와 파형은 서버로 간다).
- 무료 한도: 저장 1GB, 한 달 내려받기 10GB, 동시 연결 100. 친구끼리 쓰기에는 충분하다.
- 앱스토어 출시: 같은 웹 앱을 안드로이드 앱으로 감싸면 된다(Play 스토어용 TWA나 Capacitor). 서버는 그대로 쓴다. Claude는 필요 없다.

## 기술 메모 (다음 작업자용)

- 전송: `src/sync/firebase.js`. SDK 없이 REST(fetch)와 이벤트 스트림(text/event-stream)으로 붙는다. 데이터 모양은 파일 맨 위에 있다.
- 서버 고르기: `src/main.js`의 `chooseTransport`. 빌드가 `<meta name="hamkke-server">`를 가지면 Firebase, Claude 안이면 Claude 시험판 저장소, 둘 다 없으면 이 기기만.
- 빌드: `node tools/bundle.mjs --server=<주소>` 또는 환경 변수 `HAMKKE_SERVER`. Pages 워크플로는 저장소 변수 `HAMKKE_SERVER`를 쓴다.
- 시험: `tests/mocks/fake-firebase.mjs`가 Firebase REST·스트림·규칙을 흉내 낸다. 단위 테스트 `tests/firebase.test.js`, 화면 시나리오 "public address with a server".
- 링크의 `?server=`는 이 컴퓨터(127.0.0.1, localhost)의 시험 서버만 받는다. 남의 서버로 방을 돌리는 링크를 막기 위해서다.
