# hamkke (가칭) — 친구와 링크로 같이 쓰는 방

창작 및 앱 만들기. 친구를 링크로 방에 초대해서 같이 쓰고, 같이 노래를 만드는 웹앱.

- **일상**: 텍스트 방(한 장의 종이를 같이 쓴다, 사람마다 색, 그리기)
- **창작**: 노래 만들기 방(흥얼거리면 부른 음과 길이 그대로 피아노 음이 된다), 글쓰기·화이트보드는 준비 중

## 써 보기

- **공개 주소 (Claude 없이)**: 저장소 설정에서 GitHub Pages를 한 번 켜면 `https://ajune1028-crypto.github.io/-/` 에서 열린다
  (Settings → Pages → Source: **GitHub Actions**, 그다음 `main`에 합치면 자동으로 올라간다).
  여기서는 마이크 녹음이 된다. 아직 서버가 없어서 방은 그 기기에만 있다.
- **내 컴퓨터에서**: Node.js 22 이상, 설치할 패키지 없음.

```
npm test                     # 단위 테스트
npm run dev                  # http://127.0.0.1:8000/index.html
node tools/e2e.mjs           # 헤드리스 Chrome 화면 시나리오 (--dist: 묶은 파일로)
node tools/bundle.mjs        # dist/index.html 한 파일로 묶기
```

자세한 구조와 작업 규칙은 [`CLAUDE.md`](CLAUDE.md), 설계는 [`docs/superpowers/specs/`](docs/superpowers/specs/).
