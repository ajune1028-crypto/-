# Third-party code

이 앱은 외부 패키지를 쓰지 않는다. 아래 코드는 원리를 옮겨 와 우리 코드로 다시 썼고, 라이선스에 따라 저작권 고지를 남긴다.

## perfect-freehand

`src/core/brush.js`의 펜 윤곽(`strokePoints`, `outline`)은 perfect-freehand를 바탕으로 했다.
https://github.com/steveruizok/perfect-freehand

```
MIT License

Copyright (c) 2021 Stephen Ruiz Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Klecks

`src/core/draw.js`(그림 방의 레이어)는 Klecks의 레이어 모델을 따랐다: 이름, 보이기, 불투명도, 섞는 방식(캔버스의 합성 방식 이름 그대로), 순서, 최대 16개. 코드를 옮기지는 않았고 구조와 값의 이름을 따랐다.
https://github.com/bitbof/klecks

```
MIT License

Copyright (c) 2026 bitbof (bitbof.com)
```

## Flutter (VelocityTracker, LeastSquaresSolver)

`src/core/fling.js`의 손가락 속도(`VelocityTracker`, `fitPolynomial`)는 Flutter의 `velocity_tracker.dart`, `lsq_solver.dart`를 옮겼다: 마지막 100ms(최대 20점)를 지나는 최소제곱 2차식의 지금 기울기, 40ms 넘게 끊기면 그 앞은 버림, 40ms 멈춰 있으면 속도 0.
https://github.com/flutter/flutter

```
Copyright 2014 The Flutter Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above
      copyright notice, this list of conditions and the following
      disclaimer in the documentation and/or other materials provided
      with the distribution.
    * Neither the name of Google Inc. nor the names of its
      contributors may be used to endorse or promote products derived
      from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## lazy-brush

`src/core/brush.js`의 손떨림 보정(`LazyBrush`)은 lazy-brush를 옮겼다: 붓이 손에 매인 줄 끝에 있어서, 손이 줄 길이 안에서 움직이면 그대로 있고 더 가면 줄 길이만큼 뒤에서 끌려온다.
https://github.com/dulnan/lazy-brush

```
Copyright 2018 Jan Hug <me@dulnan.net>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Klecks의 스케치 붓 (Harmony)

`src/core/brush.js`의 `sketchLines`는 Klecks의 `sketchy-brush.ts`(Mr.doob의 Harmony에서 온 붓)를 옮겼다: 새 점마다 가까운 앞 점들과 옅은 선으로 잇되, 가까울수록 자주. 무작위는 우리 해시로 바꿔서 모든 기기에서 같은 선이 나온다. 라이선스는 위 Klecks(MIT)와 같다.

## Easy-Brush

`src/core/brush.js`의 `crayonMarks`(크레용)는 Easy-Brush의 붓 다이내믹스(크기·기울기·둥글기 흔들기, 흩뿌림, 세기 흔들기)를 옮겼다.
https://github.com/DQLean/Easy-Brush

```
Copyright (c) [2024] [dqlean]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 심플렉스 잡음 (Klecks의 perlin.ts)

`src/core/noise.js`의 `simplex2`는 Klecks가 쓰는 심플렉스 잡음을 옮겼다. 원래 Stefan Gustavson의 코드(Peter Eastman 최적화, Joseph Gentle의 JavaScript)로, 원저자가 공개 영역(public domain)에 두었다: "You may use it as you see fit, but attribution is appreciated." 연필 끝(Klecks의 분필 모양, `chalkAlpha`)을 만드는 데 쓴다.

## vaul

`src/core/fling.js`의 `gripThrow`는 vaul(서랍 컴포넌트)의 끌어 닫기 기준을 따랐다: 놓을 때 빠르기가 0.4px/ms를 넘거나(`VELOCITY_THRESHOLD`) 패널 크기의 4분의 1 이상 끌면(`CLOSE_THRESHOLD`) 받아들이고, 아니면 제자리로. 열리고 닫히는 움직임 곡선 `cubic-bezier(0.32, 0.72, 0, 1)`도 vaul과 같다.
https://github.com/emilkowalski/vaul

```
MIT License

Copyright (c) 2023 Emil Kowalski

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## SwiftF0

`src/audio/swiftf0.js`는 SwiftF0(음높이 신경망)를 외부 패키지 없이 JavaScript로 옮긴 것이다: 앞단(세 가지 STFT를 128개 로그 띠로 모으기), 합성곱 신경망, 음높이와 확신도 읽기. `src/audio/swiftf0-weights.js`의 가중치는 swift-f0 0.3.0 패키지의 `model.onnx`에서 `tools/swiftf0-export.py`로 꺼냈다. `src/audio/segment.js`의 `segmentPitch`는 SwiftF0의 `segment_notes`(음과 쉼을 가장 작은 비용으로 나누는 동적 계획법)를 바탕으로 했고, 음절 시작에서 새 음을 싸게 하는 것과 배음 바로잡기는 우리가 더했다.
https://github.com/lars76/swift-f0

```
MIT License

Copyright (c) 2025-2026 Lars Nieradzik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`src/audio/intent.js`의 조 찾기는 Krumhansl과 Kessler(1982)가 사람에게 들려 재서 낸 조성 프로필 숫자(장조·단조 각 12개)를 쓴다. 논문의 측정값이라 코드 라이선스는 없다.

정확도를 잴 때만 이 컴퓨터 안에서 HumTrans(CC BY-NC 4.0)와 Vocadito(CC BY 4.0) 녹음을 썼다. 그 녹음과 정답은 저장소에 넣지 않았다(`out/`, git에 없음).

## Klecks의 채우기 (생각만)

`src/core/fill.js`의 채우기(물감통)는 Klecks(MIT)의 채우기에서 생각을 얻었다: 색이 허용 오차 안이면 같은 곳으로 보고, 채운 곳을 1~2픽셀 키워 선의 부드러운 가장자리 밑까지 채운다(흰 틈이 안 남게). 코드는 옮기지 않고 새로 썼다(스캔라인 채우기, 픽셀 모서리를 따라 윤곽 잇기, Ramer–Douglas–Peucker 단순화). 채운 곳은 윤곽(바깥과 구멍)으로 저장해서 모든 화면에서 같게 그려진다.

## 문지르기 (libmypaint·Krita, 생각만)

`src/ui/ink.js`의 문지르기(`smudgeAlong`)는 libmypaint(ISC)의 문지르기 붓과 Krita(GPL, 생각만)의 '번지기(smearing)' 문지르기에서 생각을 얻었다: 붓 자국마다 바로 앞 자리의 그림 한 조각을 들어 지금 자리에 일부만 내려놓는다. 코드는 옮기지 않고 캔버스 합성으로 새로 썼다(부드러운 둥근 가면, 투명함까지 섞는 `destination-out` + `lighter`). 같은 획을 같은 차례로 그리면 어느 화면에서나 같게 번진다.

## 그려서 맞히기 (scribble.rs·Skribblrs.io, 생각만)

`src/core/game.js`의 그려서 맞히기는 scribble.rs(BSD-3-Clause)와 Skribblrs.io(MIT)에서 스크리블류 놀이의 판 흐름(차례로 그리는 사람, 세 낱말 중 고르기, 시간이 갈수록 늘어나는 힌트, 빨리 맞힐수록 큰 점수, 맞힌 사람마다 그린 사람 점수)을 읽고 따랐다. 코드는 옮기지 않았다. 힌트는 한국어 초성으로 새로 만들었고, 낱말 목록(`src/core/words.js`)은 우리가 직접 썼다.

