import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIsoMedia, soundTrack, audioOnlyM4a, audioAdts } from "../src/audio/mp4.js";

// A camera clip as an iPhone writes it: picture and sound chunks taking turns in
// mdat, moov at the end, the sound described the QuickTime way (version 1, esds in 'wave').
function box(type, ...parts) {
  const body = parts.flatMap((p) => [...p]);
  const size = 8 + body.length;
  return Uint8Array.from([size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body]);
}
const be = (v, w) => Uint8Array.from({ length: w }, (_, k) => Math.floor(v / 2 ** (8 * (w - 1 - k))) & 255);
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const text = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

function cameraClip() {
  const frames = [[1, 2, 3], [4, 5, 6, 7], [8, 9], [10, 11, 12, 13, 14]].map((f) => Uint8Array.from(f.map((v) => v * 3)));
  const picture = Uint8Array.from({ length: 20 }, (_, k) => 200 + k);
  const ftyp = box("ftyp", text("qt  "), be(0, 4), text("qt  "));
  // mdat: picture, frames 0-1, picture, frames 2-3.
  const data = cat(picture, frames[0], frames[1], picture, frames[2], frames[3]);
  const mdatStart = ftyp.length;
  const chunk1 = mdatStart + 8 + picture.length;
  const chunk2 = chunk1 + frames[0].length + frames[1].length + picture.length;
  const mdat = box("mdat", data);
  const asc = Uint8Array.from([0x11, 0x88]); // AAC-LC, 48 kHz, 1 channel
  const esds = box("esds", be(0, 4), Uint8Array.from([3, 25, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 5, 2, ...asc, 6, 1, 2]));
  const wave = box("wave", box("frma", text("mp4a")), box("mp4a", be(0, 4)), esds, be(8, 4), be(0, 4));
  const mp4a = box("mp4a", new Uint8Array(6), be(1, 2), be(1, 2), be(0, 2), be(0, 4), be(1, 2), be(16, 2), be(0xfffe, 2), be(0, 2), be(48000 * 65536, 4), be(1024, 4), be(0, 4), be(2, 4), be(2, 4), wave);
  const stbl = box("stbl",
    box("stsd", be(0, 4), be(1, 4), mp4a),
    box("stts", be(0, 4), be(1, 4), be(4, 4), be(1024, 4)),
    box("stsc", be(0, 4), be(1, 4), be(1, 4), be(2, 4), be(1, 4)),
    box("stsz", be(0, 4), be(0, 4), be(4, 4), ...frames.map((f) => be(f.length, 4))),
    box("stco", be(0, 4), be(2, 4), be(chunk1, 4), be(chunk2, 4)));
  const sound = box("trak", box("mdia",
    box("mdhd", be(0, 4), be(0, 4), be(0, 4), be(48000, 4), be(4096, 4), be(0x55c4, 2), be(0, 2)),
    box("hdlr", be(0, 4), text("mhlr"), text("soun"), new Uint8Array(12), be(0, 1)),
    box("minf", box("smhd", be(0, 8)), stbl)));
  const video = box("trak", box("mdia",
    box("mdhd", be(0, 4), be(0, 4), be(0, 4), be(600, 4), be(600, 4), be(0, 4)),
    box("hdlr", be(0, 4), text("mhlr"), text("vide"), new Uint8Array(12), be(0, 1)),
    box("minf", box("vmhd", be(0, 12)), box("stbl", box("stsd", be(0, 4), be(1, 4), box("avc1", new Uint8Array(70)))))));
  const moov = box("moov", box("mvhd", new Uint8Array(100)), video, sound);
  return { file: cat(ftyp, mdat, moov), frames };
}

test("the sound of a camera clip (.mov, moov at the end, picture in between) is found frame by frame", () => {
  const { file, frames } = cameraClip();
  assert.ok(isIsoMedia(file));
  const t = soundTrack(file);
  assert.equal(t.samples.length, 4);
  assert.deepEqual(t.samples.map(([at, size]) => [...file.subarray(at, at + size)]), frames.map((f) => [...f]));
  assert.deepEqual([t.timescale, t.duration, t.rate, t.channels, t.asc.type], [48000, 4096, 48000, 1, 2]);
});

test("as a plain .m4a it holds just the sound: the same frames in one run, read back the same", () => {
  const { file, frames } = cameraClip();
  const m4a = audioOnlyM4a(file);
  assert.equal(String.fromCharCode(...m4a.subarray(8, 12)), "M4A ");
  const again = soundTrack(m4a);
  assert.deepEqual(again.samples.map(([at, size]) => [...m4a.subarray(at, at + size)]), frames.map((f) => [...f]));
  assert.deepEqual([again.timescale, again.duration, again.rate, again.channels], [48000, 4096, 48000, 1]);
  assert.ok(!new TextDecoder("latin1").decode(m4a).includes("vide"), "no picture track");
});

test("as ADTS every frame gets its 7-byte header with the right length", () => {
  const { file, frames } = cameraClip();
  const adts = audioAdts(file);
  let at = 0;
  for (const f of frames) {
    assert.equal(adts[at], 0xff);
    assert.equal(adts[at + 1] & 0xf0, 0xf0);
    const len = ((adts[at + 3] & 3) << 11) | (adts[at + 4] << 3) | (adts[at + 5] >> 5);
    assert.equal(len, f.length + 7);
    assert.equal((adts[at + 2] >> 2) & 15, 3, "48 kHz");
    at += len;
  }
  assert.equal(at, adts.length);
});

test("not a media file, or one without sound: nothing", () => {
  assert.equal(isIsoMedia(text("RIFF....WAVEfmt ")), false);
  assert.equal(soundTrack(text("garbage that is not a box at all")), null);
  assert.equal(audioOnlyM4a(cat(box("ftyp", text("qt  ")), box("moov", box("mvhd", new Uint8Array(100))))), null);
});

let ffmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { ffmpeg = false; }

test("a real camera-style .mov (ffmpeg's QuickTime writer) gives an .m4a that decodes to the same length", { skip: !ffmpeg && "no ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hamkke-mov-"));
  const mov = join(dir, "cam.mov");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5:sample_rate=48000", "-f", "lavfi", "-i", "testsrc=size=96x64:rate=10:duration=1.5", "-c:a", "aac", "-c:v", "mpeg4", "-shortest", mov]);
  const m4a = audioOnlyM4a(new Uint8Array(readFileSync(mov)));
  writeFileSync(join(dir, "out.m4a"), m4a);
  const probe = (f) => execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "compact=p=0:nk=1", f]).toString().trim().split("\n");
  const was = probe(mov);
  const now = probe(join(dir, "out.m4a"));
  assert.deepEqual(now.slice(0, -1), ["audio"], "only sound: " + now);
  assert.ok(Math.abs(Number(now.at(-1)) - Number(was.at(-1))) < 0.06, `${now.at(-1)} vs ${was.at(-1)}`);
});
