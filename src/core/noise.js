// 2D simplex noise, for brush tips that look drawn rather than stamped (Klecks' chalk).
//
// Ported from Klecks (bb/math/perlin.ts), itself Joseph Gentle's JavaScript version of Stefan
// Gustavson's simplex noise, which its author placed in the public domain ("You may use it as you
// see fit, but attribution is appreciated"; THIRD_PARTY.md). Seed 0, as Klecks uses it, so every
// device makes the very same tip.

const GRAD3 = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0, 1], [0, -1]];
const P = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26,
  197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158,
  231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
  200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227,
  47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79,
  113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31,
  181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
];
const perm = new Array(512);
const gradP = new Array(512);
// seed(0): the low and high bytes of 0 change nothing, so the table is P itself.
for (let i = 0; i < 256; i++) {
  perm[i] = perm[i + 256] = P[i];
  gradP[i] = gradP[i + 256] = GRAD3[P[i] % 12];
}
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** Simplex noise at (x, y): smooth, in -1..1. */
export function simplex2(xin, yin) {
  const s = (xin + yin) * F2;
  let i = Math.floor(xin + s);
  let j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - i + t;
  const y0 = yin - j + t;
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  i &= 255;
  j &= 255;
  const g0 = gradP[i + perm[j]];
  const g1 = gradP[i + i1 + perm[j + j1]];
  const g2 = gradP[i + 1 + perm[j + 1]];
  const corner = (g, x, y) => {
    let k = 0.5 - x * x - y * y;
    if (k < 0) return 0;
    k *= k;
    return k * k * (g[0] * x + g[1] * y);
  };
  return 70 * (corner(g0, x0, y0) + corner(g1, x1, y1) + corner(g2, x2, y2));
}
