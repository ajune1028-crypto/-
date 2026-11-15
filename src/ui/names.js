// What a recording is, in a person's words: its name and what it came from
// (the owner: "mp3 가지고 왔으면 그것의 이름과 어떤 mp3인지 알려주고").

const KINDS = {
  mp3: "mp3", m4a: "m4a", wav: "wav", aac: "aac", ogg: "ogg", oga: "ogg", opus: "opus", webm: "webm",
  flac: "flac", amr: "amr", "3gp": "3gp", mov: "영상", mp4: "영상", "3g2": "영상",
};

/**
 * { title, kind, long }: a file's name without its ending and what kind of file it was
 * ("노래", "mp3", "mp3 파일"); a take made here has no name: `fallback` and "녹음".
 */
export function soundTitle(name, fallback = "녹음") {
  const raw = String(name || "").trim();
  if (!raw) return { title: fallback, kind: "녹음", long: "이 앱에서 녹음" };
  const m = /^(.*)\.([a-z0-9]{2,4})$/i.exec(raw);
  const kind = m && KINDS[m[2].toLowerCase()];
  if (kind) return { title: m[1] || raw, kind, long: kind === "영상" ? "영상의 소리" : kind + " 파일" };
  return { title: raw, kind: null, long: null };
}
