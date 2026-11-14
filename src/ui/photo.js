// Photos made small enough to travel inside one op: a text room's hidden photo, a whiteboard's
// photo card. The longest side steps down and the JPEG quality with it until it fits.

import { MAX_ATT_CHARS } from "../core/crdt.js";

/** { data: "data:image/jpeg;base64,…", w, h } at most maxChars long, or null when it cannot be read. */
export async function shrinkPhoto(file, maxChars = MAX_ATT_CHARS) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    for (const side of [720, 560, 440, 340, 260]) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k));
      const h = Math.max(1, Math.round(img.naturalHeight * k));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      for (const q of [0.72, 0.6, 0.48]) {
        const data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= maxChars) return { data, w, h };
      }
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
