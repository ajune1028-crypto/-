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
