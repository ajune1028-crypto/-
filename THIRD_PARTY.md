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
