# Writes src/audio/swiftf0-weights.js from SwiftF0's ONNX model (MIT, Lars Nieradzik,
# https://github.com/lars76/swift-f0). Only needed when the model changes; the app itself has no Python.
#
#   pip download swift-f0 --no-deps   →  unzip the wheel  →  swift_f0/model.onnx
#   pip install onnx numpy
#   python3 tools/swiftf0-export.py path/to/model.onnx
#
# The weights go into the page as base64 float32 (about 100 KB of text). The filterbanks are kept as
# (bin, band, weight) entries; the windows (periodic Hann) and the 95 pitch steps are computed in JS.
import base64, sys
import numpy as np
import onnx
from onnx import numpy_helper

model = onnx.load(sys.argv[1])
W = {t.name: numpy_helper.to_array(t) for t in model.graph.initializer}
LAYERS = [("conv1", "v353", "v354"), ("a1", "v357", "v358"), ("a2", "v361", "v362"), ("b1", "v366", "v367"), ("b2", "v370", "v371"),
          ("c1", "v375", "v376"), ("c2", "v379", "v380"), ("d1", "v384", "v385"), ("d2", "v388", "v389"), ("e1", "v393", "v394"),
          ("e2", "v397", "v398"), ("f1", "v402", "v403"), ("f2", "v406", "v407"), ("head", "v413", "v414"), ("conf2d", "v417", "v418"),
          ("pitch", "v425", "v426"), ("conf1a", "v430", "v431"), ("conf1b", "v434", "v435")]
flat, index = [], {}
for name, w, b in LAYERS:
    wa, ba = W[w].astype(np.float32), W[b].astype(np.float32)
    index[name] = (list(wa.shape), len(flat), len(flat) + wa.size)
    flat += wa.ravel().tolist() + ba.ravel().tolist()
b64 = lambda a: base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()
banks = {}
for key, idx, val, bins in [("fb512", "v342", "v343", 257), ("fb1024", "v123", "v124", 513), ("fb2048", "v241", "v242", 1025)]:
    I, V = W[idx].astype(np.int64), W[val].astype(np.float32)
    keep = V > 1e-9  # a handful of 1e-16 weights change nothing
    I, V = I[keep], V[keep]
    order = np.lexsort((I // 128, I % 128))
    I, V = I[order], V[order]
    banks[key] = (bins, b64((I // 128).astype(np.uint16)), b64((I % 128).astype(np.uint8)), b64(V))
lines = [
    "// SwiftF0's weights (MIT License, Copyright (c) 2025-2026 Lars Nieradzik, https://github.com/lars76/swift-f0;",
    "// the licence text is in THIRD_PARTY.md). Written by tools/swiftf0-export.py from the model in swift-f0 0.3.0.",
    "// Layers: [shape, start of weights, start of bias] in SWIFT_WEIGHTS (float32, little-endian, base64).",
    "",
    "export const SWIFT_LAYERS = {",
]
for name, (shape, w, b) in index.items():
    lines.append(f"  {name}: [{shape}, {w}, {b}],")
lines += ["};", "", f'export const SWIFT_WEIGHTS = "{b64(np.array(flat, dtype=np.float32))}";', "",
          "// Filterbanks: spectrum bins → 128 bands. Each entry: a bin (uint16), its band (uint8), the weight (float32).",
          "export const SWIFT_BANKS = {"]
for key, (bins, bi, ba, wv) in banks.items():
    lines.append(f'  {key}: {{ bins: {bins}, bin: "{bi}", band: "{ba}", w: "{wv}" }},')
lines += ["};", ""]
out = "src/audio/swiftf0-weights.js"
open(out, "w").write("\n".join(lines))
print(out, len(flat), "weights,", {k: v[0] for k, v in banks.items()})
