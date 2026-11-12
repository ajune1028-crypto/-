# Foundation + Daily Text Room, Phase 1 ("같이 쓰기") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web app where two screens open the same room and write on one shared sheet in real time, with word-level author colours, colour mixing, personal codes, and a published trial page.

**Architecture:** Every change is a small op that converges in any order (hand-written sequence CRDT + last-writer-wins registers). A `RoomSession` applies ops locally first and hands them to a `Transport`; the app never knows which transport it has. Two transports ship now: `LocalTransport` (same browser, tests) and `ClaudeTransport` (the trial page's shared store + live channel).

**Tech Stack:** Plain ES modules, no dependencies, no build step for development. Node 22 built-in test runner. Headless Chrome driven over CDP for two-screen tests. A small bundler writes one HTML file for the trial page.

**Spec:** `docs/superpowers/specs/2026-11-10-foundation-text-room-design.md` (sections 2 "1차", 4, 5.1–5.4, 5.9–5.10, 6, 7, 8, 9 "1차") and `docs/superpowers/specs/2026-11-10-app-overview-design.md` (sections 6, 7).

**Execution:** Native, in this session. The user waived spec and plan review on 2026-11-11 and again on 2026-11-12 ("묻지 말고 스스로 확인하며 진행"). No subagents: the user did not ask for them.

## Global Constraints

- No external libraries at runtime or in tests. Package installs are refused in this workspace.
- Source files use only these module forms so the bundler can rewrite them: `import { a, b as c } from "./x.js";` and `export function|async function|class|const NAME`. No default exports, no re-exports, no circular imports.
- Never write the literal `</script` in source.
- All layout is phone-portrait at logical width `360`. The app column is zoomed by `clamp(viewport width / 360, 1, 1.4)` and centred.
- Editor font size is `16px` logical (iOS zooms the page when a focused field is smaller).
- Body text contrast against the sheet paper is at least `4.5:1` in light and dark.
- Motion respects `prefers-reduced-motion`.
- A "줄" is a newline-separated line. An "어절" is a whitespace-separated run. Colour is decided per 어절, time stamps per 줄.
- Mix levels: `0` none, `1` 스며들기, `2` 진짜 섞기, then back to `0`.
- Personal code: exactly 5 digits. Five wrong attempts lock for `30` seconds.
- Undo: own changes only, typing merges when gaps are under `1000` ms, depth `100`.
- First load shows the latest `7` sheets that exist, plus today.
- Copy fixed by the spec: day header `11월 10일 화요일`; hour stamp `오후 3시`; late addition on a past sheet `11월 12일 오후 3시`; storage notice `이 기기에는 방 목록이 저장되지 않아요`; version notice `새 버전이 있어요. 새로고침해 주세요`; slow transport `아직 연결 중`.
- Dev URL parameters (ignored on the trial page): `dev` separates device storage, `ns` separates room storage, so one browser can play two devices.

## Review Focus

1. **Hangul composition.** Jamo arrive as replace-in-place edits. Expected: the other screen sees `ㅎ → 하 → 한`, and the sheet keeps one character, not three with two tombstones. Test in Task 2 (`set` path) and Task 8 (CDP `Input.imeSetComposition`).
2. **Large paste and emoji.** A 5,000-character paste and surrogate pairs. Expected: both screens converge, an emoji never splits, live messages stay under the 4 KiB channel limit. Tests in Task 2 and Task 6.
3. **Wrong device clock.** A device whose clock is hours off. Expected: text order is unaffected, only stamps look odd. Test in Task 1.
4. **Two tabs on one device.** Expected: no id collisions, both tabs are the same person. Test in Task 5.
5. **Storage refused.** `localStorage` throws inside the trial frame. Expected: the app runs from memory and shows the storage notice once. Test in Task 5 and Task 7.

---

## File Structure

```
index.html                 dev shell: loads src/ui/theme.css and src/main.js
src/core/crdt.js           ids, Clock, Sheet (ins/set/vis/mix, pending, unknown)
src/core/edit.js           text diff, ops for edits, mix, undo/redo inversion
src/core/undo.js           UndoStack
src/core/paint.js          palette, OKLCH, 어절 splitting, paint rules, CSS, mixing, contrast
src/core/room.js           room/member ids, verifier (password, code), RoomState, Attempts
src/core/time.js           day key, day label, hour label, line stamps
src/sync/transport.js      typedefs, Emitter
src/sync/local.js          LocalTransport
src/sync/claude.js         ClaudeTransport
src/sync/session.js        RoomSession
src/identity.js            device store (rooms, who I am per room, last name/code, settings, outbox)
src/ui/dom.js              h(), sheet(), toast()
src/ui/theme.css           tokens, grain, components
src/ui/theme.js            theme apply, grain texture, zoom
src/ui/home.js             home (split), create room
src/ui/join.js             join: new person / returning person + code
src/ui/room-shell.js       top bar, settings sheet, invite, diagnostics
src/ui/editor.js           SheetEditor: draw layer + input layer
src/ui/text-room.js        sheets list, stamps, toolbar
src/main.js                boot, transport choice, routing
tests/*.test.js            node --test
tests/mocks/claude-runtime.js
tools/serve.mjs  tools/cdp.mjs  tools/e2e.mjs  tools/bundle.mjs
dist/index.html            bundled single file (generated)
```

---

### Task 1: Sequence CRDT

**Files:** Create `src/core/crdt.js`, `tests/crdt.test.js`, `package.json` (`{"type":"module","scripts":{"test":"node --test tests/"}}`).

**Interfaces — Produces:**
- `ROOT = "0"`, `makeId(n: number, replica: string): string` → `"n@replica"`, `cmpId(a, b): -1|0|1` (number first, then replica; ROOT is lowest).
- `class Clock { constructor(replica); next(): string; see(id: string): void }` — `next()` is always greater than everything seen.
- Ops: `{t:"ins", id, after, v, by, at}` (`v` one UTF-16 unit), `{t:"set", id, ch, v}`, `{t:"vis", id, ch, n}`, `{t:"mix", id, ch, lv}`.
- `class Sheet { version; apply(op): "applied"|"dup"|"pending"|"unknown"; applyAll(ops): boolean; chars(): {id,v,by,at}[]; ids(): string[]; text(): string; get(id); indexOfId(id): number; mixLevel(id): 0|1|2; size; pendingCount; unknown: object[] }`.
- Rules: insert goes right after `after`, skipping right-hand nodes whose id is greater; `set` and `mix` are last-writer-wins by op id; `vis` keeps `max(n)`, odd means hidden; ops naming a missing char wait in `pending`; malformed or unknown ops go to `unknown` and never throw.

- [ ] **Step 1: Write the failing tests**

```js
test("concurrent inserts after the same char converge with the greater id first", () => { /* A:"x" after ROOT as 1@a; B and C both insert after it as 2@b,2@c → every order gives "x" + c + b */ });
test("delete and restore: max counter wins, odd hides", () => { /* vis n=1 hides, n=2 shows, late n=1 ignored */ });
test("set is last-writer-wins and keeps one node", () => { /* ㅎ → 하 → 한 on one char: text "한", size 1 */ });
test("ops arriving before their char wait, then apply", () => { /* returns "pending", then text correct */ });
test("unknown and malformed ops are kept aside without throwing", () => { /* {t:"zzz"}, v:"ab", missing id */ });
test("wrong clocks do not change order", () => { /* at: 0 and at: 9e15 */ });
test("random scenarios converge", () => { /* 1000 runs: 3 replicas, random ins/vis/set/mix, shuffled + duplicated delivery; texts, mix levels and ids equal */ });
```

- [ ] **Step 2:** Run `node --test tests/crdt.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `src/core/crdt.js` (linked list + `Map` by id; visible cache rebuilt per `version`).
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat: sequence CRDT for sheets`.

### Task 2: Edits, mixing, undo

**Files:** Create `src/core/edit.js`, `src/core/undo.js`, `tests/edit.test.js`.

**Interfaces — Consumes:** Task 1. **Produces:**
- `diffText(prev: string, next: string, caret?: number): {index, del, ins}` — one splice; `caret` (selection end after the edit) picks the position among repeated characters.
- `spliceOps(sheet, clock, ctx: {by, now}, snapIds: string[], index, del, ins: string, composing: boolean): {ops, atoms, ids: string[]}` — `ids` is the new `snapIds`. While composing, the leading `min(del, ins.length)` characters become `set` ops when every one of them is `by` the same person; otherwise delete + insert.
- `mixOps(sheet, clock, anchorId): {ops, atoms}` — level `(cur + 1) % 3`.
- `invertOps(sheet, clock, atoms, dir: "undo"|"redo"): Op[]`.
- Atoms: `{k:"ins", ids}`, `{k:"del", ids}`, `{k:"set", ch, prev, next}`, `{k:"mix", ch, prev, next}`.
- `class UndoStack { constructor(limit = 100, mergeMs = 1000); record(atoms, {now, typing}); undo(): atoms[]|null; redo(): atoms[]|null; canUndo; canRedo }`.

- [ ] **Step 1: Write the failing tests**

```js
test("diffText finds one splice", () => { assert.deepEqual(diffText("abc", "abXc"), {index: 2, del: 0, ins: "X"}); assert.deepEqual(diffText("abc", "ac"), {index: 1, del: 1, ins: ""}); });
test("diffText uses the caret among repeated characters", () => { assert.deepEqual(diffText("aaa", "aaaa", 2), {index: 1, del: 0, ins: "a"}); });
test("composition replaces in place: one node, text 한", () => { /* ins ㅎ, then composing replace → 하 → 한; sheet.size === 1 */ });
test("composition over someone else's char falls back to delete + insert", () => {});
test("typing in the middle keeps snapIds aligned with text", () => { /* after each splice ids.length === text.length and ids match sheet.ids() */ });
test("emoji stays two adjacent units", () => { /* "😀" → 2 ins, text round-trips */ });
test("5,000-character paste applies and converges on a second sheet", () => {});
test("mix cycles 0 → 1 → 2 → 0", () => {});
test("undo removes only my typing; redo restores it", () => { /* B's chars untouched */ });
test("undo of delete restores, undo of mix restores the level", () => {});
test("typing within 1000 ms merges into one undo step; a pause splits", () => {});
test("undo depth is 100", () => {});
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement both files.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: edit ops, mixing and undo`.

### Task 3: Paint

**Files:** Create `src/core/paint.js`, `tests/paint.test.js`.

**Interfaces — Produces:**
- `PALETTE`: 8 entries `{key, h, c}`; `INK = {light, dark}`, `PAPER = {light, dark}` hex.
- `memberColor(index: number, theme: "light"|"dark"): string` hex.
- `hexToOklch(hex): {l, c, h}`, `oklchToHex(l, c, h): string`, `contrast(a, b): number`.
- `mixColors(hexes: string[], theme): string` — hue travels the shorter arc (red + blue → purple, blue + yellow → green), chroma eases off for wide arcs, lightness is clamped so the result keeps `4.5:1` on `PAPER[theme]`.
- `splitWords(chars): Word[]`, `Word = {start, end, line, anchor, authors: string[], top: string}` — `authors` ordered by each person's earliest remaining char id; `top` is the majority author (ties: earliest).
- `paintFor(word, left: Word|null, right: Word|null, o: {color(by): string, level, colors: boolean, mixing: boolean, ink, theme}): Paint`.
- `paintCss(paint): {color?: string, background?: string}`.
- Paint: `{k:"ink"}`, `{k:"solid", c}`, `{k:"split", top, bottom}`, `{k:"wheel", cs}`, `{k:"seep", base, l, r}`.
- Rules: colours off → ink. Mixing off → solid `top`. One author → solid; two → split, first writer on top; three or more → wheel, equal sectors, first writer centred at 12 o'clock, clockwise. Level 1 → seep with neighbours on the same line (neighbour colour = its first writer); a missing side stays as is; no neighbours → base. Level 2 → solid `mixColors` of the word's authors plus neighbours.

- [ ] **Step 1: Write the failing tests**

```js
test("every palette colour reads at 4.5:1 on paper, light and dark", () => {});
test("palette colours are pairwise distinct in hue by at least 30 degrees", () => {});
test("hex ↔ oklch round-trips within 1/255", () => {});
test("red + blue mixes to purple (hue 280–345), blue + yellow to green (hue 125–200)", () => {});
test("a mixed colour still reads at 4.5:1 in both themes", () => {});
test("splitWords: spaces and newlines separate, lines count up", () => { /* "ab cd\nef" → 3 words, lines 0,0,1 */ });
test("authors are ordered by first written, top is the majority", () => {});
test("one author solid, two split with first writer on top, three wheel", () => {});
test("mixing off gives the majority colour and ignores levels", () => {});
test("colours off gives ink", () => {});
test("level 1 seeps neighbours of the same line only", () => { /* word at line start has no left */ });
test("level 2 is one solid mixed colour", () => {});
test("paintCss: split is a vertical gradient, wheel a conic gradient with N plateaus, seep has side layers", () => {});
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: word colours and mixing`.

### Task 4: Room and time

**Files:** Create `src/core/room.js`, `src/core/time.js`, `tests/room.test.js`, `tests/time.test.js`.

**Interfaces — Produces:**
- `newRoomId(): string` (12 chars of `a-z2-7`), `newMemberId(): string` (8 chars), `newReplicaId(): string` (6 chars).
- `makeVerifier(secret): Promise<{salt, hash}>`, `checkVerifier(secret, v): Promise<boolean>` (SHA-256 of `salt:secret`), `validPin(s): boolean` (`/^\d{5}$/`).
- `class Attempts { fail(now); ok(); lockedMs(now): number }` — 5 fails → 30,000 ms.
- Room ops: `{t:"meta", id, k, v}`, `{t:"mem", id, m, k, v}` with `k` in `name|color|pin|joinedAt`.
- `class RoomState { version; apply(op); applyAll(ops); meta(k); members(): {id, name, color, pin, joinedAt}[]; member(id); freeColor(): number }`.
- `createRoomOps(clock, {kind, name, tz, now, memberId, memberName, pin}): Op[]`, `joinOps(clock, room, {memberId, name, pin, now}): Op[]`.
- `dayKey(ms, tz): "YYYY-MM-DD"`, `dayLabel(key): string`, `hourLabel(ms, tz): string`, `lineStamps(lines: {at: number|null}[], tz, sheetDay): (string|null)[]`.

- [ ] **Step 1: Write the failing tests**

```js
test("ids have the right alphabet and length and do not repeat in 10,000 draws", () => {});
test("verifier accepts the right secret and rejects a wrong one", async () => {});
test("validPin accepts 5 digits only", () => { /* "12345" ok; "1234", "123456", "12a45", " 12345" not */ });
test("five failures lock for 30 seconds, success resets", () => {});
test("room meta and member fields are last-writer-wins per field, any order", () => {});
test("freeColor returns the lowest unused palette index, then the least used", () => {});
test("dayKey respects the room time zone", () => { /* 2026-11-10T15:30Z → "2026-11-11" in Asia/Seoul, "2026-11-10" in UTC */ });
test("dayLabel and hourLabel", () => { assert.equal(dayLabel("2026-11-10"), "11월 10일 화요일"); /* 15:00 → "오후 3시", 00:10 → "오전 12시", 12:00 → "오후 12시" */ });
test("lineStamps: label only when the hour bucket changes; empty lines get none; other-day lines carry the date", () => { /* "11월 12일 오후 3시" */ });
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: room state, verifiers, time labels`.

### Task 5: Local transport, session, device store

**Files:** Create `src/sync/transport.js`, `src/sync/local.js`, `src/sync/session.js`, `src/identity.js`, `tests/session.test.js`.

**Interfaces — Produces:**
- `class Emitter { on(type, fn): () => void; emit(type, data) }`.
- Transport contract (the spec's 6.4, with a room-wide subscription): `createRoom({id, kind, name}): Promise<void>`, `openRoom(id): Promise<RoomChannel|null>`, `listRooms(): Promise<{id, kind, name}[]>`, `info(): object`.
- RoomChannel: `docs(): Promise<string[]>`, `load(docId): Promise<Op[]>`, `append(docId, ops): Promise<void>`, `subscribe(fn: (docId, ops) => void): () => void`, `setPresence(state)`, `onPresence(fn: (peers: {key, isMe, state}[]) => void): () => void`, `onStatus(fn: ("online"|"offline") => void): () => void`, `close()`.
- `memoryStorage(): Storage-like`, `class LocalTransport { constructor({ns = "main", storage, offline = false}); setOffline(b) }` — `BroadcastChannel("hamkke:" + ns)`; while offline, appends are stored but not broadcast or received; going online triggers a catch-up `load`.
- `openStore(storage?, prefix = ""): { available: boolean; get(key, fallback); set(key, value) }` — never throws; `available` is false when the backing storage throws.
- Store keys: `rooms` → `{id, kind, name, memberId, at}[]`, `last` → `{name, pin}`, `settings` → `{theme: "system", colors: true, mixing: true}`, `outbox:<roomId>` → `{doc, ops}[]`.
- `class RoomSession extends Emitter { constructor({transport, roomId, clock, store}); open(): Promise<"ok"|"missing">; room: RoomState; me; setMe(memberId); days(): string[]; sheet(day): Sheet; loadSheet(day): Promise<Sheet>; commit(docId, ops); pending: number; status; close() }` — events `change {docId}`, `peers`, `status`, `unknown`. Doc ids: `"room"`, `"s:" + day`. `commit` applies locally first, persists the outbox, appends with retry (1 s, 2 s, 5 s, then every 10 s).

- [ ] **Step 1: Write the failing tests**

```js
test("two sessions on one LocalTransport namespace converge on text", async () => {});
test("offline edits are delivered after going online", async () => {});
test("a new session loads what was written before it opened", async () => {});
test("two sessions with the same device store get different replicas and never collide", async () => {});
test("the outbox survives a reopen", async () => { /* commit while append rejects, close, reopen → delivered */ });
test("openRoom on an unknown id resolves 'missing'", async () => {});
test("openStore over a throwing storage is unavailable but works from memory", () => {});
test("ops with an unknown type raise 'unknown' once and are kept", async () => {});
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: local transport, room session, device store`.

### Task 6: Claude transport

**Files:** Create `src/sync/claude.js`, `tests/mocks/claude-runtime.js`, `tests/claude.test.js`.

**Interfaces — Consumes:** Task 5 contract. **Produces:**
- `class ClaudeTransport { static async connect(claude, {timeoutMs = 10000} = {}): Promise<ClaudeTransport|null> }` — `null` when `claude.use("db")` resolves `null` or times out.
- Store layout: `rooms/{id}` → `{id, kind, name, at}`; `rooms/{id}/logs/{doc}~{replica}~{chunk}` → `{d, r, c, ops}`. A chunk holds at most `200` ops or `48,000` JSON characters. One `set` in flight per chunk document; writes coalesce for `250` ms.
- Live path: named room `id`; topic `ops` carries `{d, o}`; a message is sent only when its JSON is at most `3,500` bytes, otherwise it is split, and anything still too large is left to the store.
- Catch-up: one `onSnapshot` on `rooms/{id}/logs`; per chunk document deliver `ops.slice(seen)`.
- `info()` → `{kind: "claude", db, live, peers, pending, lastError}`.
- Mock: `makeRuntime()` → `{view(): {use(name)}, lossy: boolean, snapshotDelayMs}`; each `view()` is one screen sharing one store.

- [ ] **Step 1: Write the failing tests**

```js
test("connect resolves null when db is unavailable", async () => {});
test("ops written by one view reach the other through the store alone", async () => { /* lossy = true drops every live message */ });
test("live messages deliver before the store write resolves", async () => {});
test("a late joiner loads everything", async () => {});
test("5,000-character paste: every live message is under 3,500 bytes and both sides converge", async () => {});
test("chunks roll over at 200 ops", async () => {});
test("a rejected write is retried and status goes offline then online", async () => {});
test("listRooms returns rooms created by another view", async () => {});
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: trial transport over the page store and live channel`.

### Task 7: Shell, home, join

**Files:** Create `index.html`, `src/ui/dom.js`, `src/ui/theme.css`, `src/ui/theme.js`, `src/ui/home.js`, `src/ui/join.js`, `src/ui/room-shell.js`, `src/main.js`, `tools/serve.mjs`, `tools/cdp.mjs`, `tools/e2e.mjs`.

**Interfaces — Produces:**
- `boot(root)` in `main.js`; routing on `location.hash`: empty → home, `#r-<roomId>` → room.
- `window.__app = {store, transport, session, editors, go(hash)}` for tests.
- `tools/cdp.mjs`: `launch(): Promise<{page(url, {width = 360, height = 760, dark = false}), close()}>`; page: `eval(expr)`, `waitFor(expr, ms = 5000)`, `type(text)`, `ime(text)`, `commit(text)`, `key(name)`, `tap(x, y)`, `dblTap(x, y)`, `shot(file)`, `close()`.
- Home: left half 일상, right half 창작, each with a title, a `+` button and room cards; `+` on 일상 offers 텍스트 (enabled), 사진 and 통합 (`준비 중`); `+` on 창작 offers 노래 만들기, 글쓰기, 화이트보드 (all `준비 중`). Trial extras: `다른 기기에서 만든 방` list and `코드로 들어가기`.
- Join: `처음 왔어요` (name, auto colour, optional code) and `원래 있던 사람이에요` (pick name, enter code).
- Settings sheet: room name (owner), my name and colour, set or change code, theme, 색 구분, 색 섞기, room code + copy, 연결 진단, 방 나가기.

- [ ] **Step 1: Write the failing scenarios in `tools/e2e.mjs`**

```
home: both halves render at 360 wide, no horizontal overflow
create: + → 텍스트 → name → lands in the room, hash is #r-<id>, the room card is on home after going back
second device: sees the room under 다른 기기에서 만든 방, joins as a new person with another colour
returning: third device picks the first person's name, wrong code is refused, right code enters with the same colour
lockout: five wrong codes show the 30-second wait
storage refused: with ?dev=broken the app runs and shows 이 기기에는 방 목록이 저장되지 않아요
```

- [ ] **Step 2:** Run `node tools/e2e.mjs`. Expected: FAIL (nothing to load).
- [ ] **Step 3:** Implement the shell and screens.
- [ ] **Step 4:** Run. Expected: these scenarios PASS. Look at `out/home-light.png` and `out/home-dark.png`.
- [ ] **Step 5:** Commit `feat: shell, home, join, settings`.

### Task 8: Text room

**Files:** Create `src/ui/editor.js`, `src/ui/text-room.js`; modify `src/main.js`, `tools/e2e.mjs`.

**Interfaces — Consumes:** Tasks 1–5, 7. **Produces:**
- `class SheetEditor { constructor({session, day, host, opts}); render(); syncInput(); focus(); destroy() }` — draw layer `div.draw` + input layer `textarea.input`, same typography; `snap = {text, ids}` mirrors the textarea; input → `diffText` → `spliceOps` → `session.commit`; remote changes redraw at once and reach the textarea only when not composing; own and remote carets are drawn from char ids; two taps within `300` ms and `24` px on one 어절 mix it when the room is 일상 and mixing is on.
- Text room: day headers, stamps in a left gutter, `이전 날짜 더 보기`, toolbar with 실행취소, 다시실행, 색 구분.

- [ ] **Step 1: Add the failing scenarios**

```
typing: A types, B shows the same text within 1 s
concurrent: A and B type at once in the same line, both end equal and nothing is lost
hangul: A composes ㅎ → 하 → 한 with ime(); B sees 한; the sheet holds one char for it
colours: a word typed by A alone is solid; B appends to it → split; C appends → wheel; computed backgrounds match
mix: double tap cycles seep → solid → base on both screens; with 색 섞기 off the word is one solid colour and levels are ignored
colours off: every word uses the ink colour
offline: A goes offline, types, comes back → B catches up
undo: A's undo removes A's typing only
refresh: reload keeps the text and my identity
layers: for random text, draw and input layers have equal height and each line's first char sits within 1 px
stamps: lines an hour apart get two stamps; the day header matches dayLabel
overflow: a 300-character unbroken string wraps and never widens the page
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Look at `out/room-light.png`, `out/room-dark.png`, `out/room-wheel.png`.
- [ ] **Step 5:** Commit `feat: text room with shared editing, colours and mixing`.

### Task 9: Design pass and error states

**Files:** Modify `src/ui/theme.css`, `src/ui/*.js`, `tools/e2e.mjs`.

- [ ] **Step 1: Add the failing checks**

```
contrast: sampled text colours against the paper are ≥ 4.5 in light and dark for ink and all 8 member colours
reduced motion: with prefers-reduced-motion the wheel does not spin
read-only: a channel that refuses writes hides the toolbar and shows 보기만 할 수 있어요
slow transport: a transport that never answers shows 아직 연결 중 and the page stays usable
unknown ops: an op with an unknown type shows 새 버전이 있어요. 새로고침해 주세요
diagnostics: 연결 진단 lists transport kind, pending count and version
wide screen: at 1280×800 the column is centred and zoomed 1.4
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; refine the visuals against the three reference images (grain, soft colour fields, gradient hairline cards, restrained chrome).
- [ ] **Step 4:** Run. Expected: PASS. Review every screenshot in `out/`.
- [ ] **Step 5:** Commit `feat: design pass and error states`.

### Task 10: Bundle and publish the trial

**Files:** Create `tools/bundle.mjs`; modify `tools/e2e.mjs` (accept `--dist`), spec files.

- [ ] **Step 1:** `tools/bundle.mjs` writes `dist/index.html`: inlined CSS, modules wrapped in dependency order inside one script, imports and exports rewritten.
- [ ] **Step 2:** Run `node tools/bundle.mjs && node tools/e2e.mjs --dist`. Expected: every scenario PASS against the bundle.
- [ ] **Step 3:** Publish `dist/index.html` as an artifact, then declare `{db: {}, user: {}, room: {topics: {ops: "interact"}}}`.
- [ ] **Step 4:** Tick the finished items in the overview's section 8, record deviations in section 9, re-read section 11.
- [ ] **Step 5:** Commit `feat: bundle and trial page`.

---

## Self-Review

- **Spec coverage:** 1차 items map to tasks: home (7), person and code (4, 7), create/invite/join (7), shared writing (1, 2, 5, 8), word colours and mixing (3, 8), stamps and day sheets (4, 8), themes (7, 9), undo (2, 8), trial (6, 10), diagnostics (9), bundling (10), errors of section 7 that apply to 1차 (5, 7, 9). Password screen, background, sparkle, marks, ink and lock are 2차 and out of this plan.
- **Deviation from the spec's 6.4:** `subscribe` is room-wide and `docs()` is added, because day sheets appear while a room is open. The spec is updated in Task 10.
- **Deferred within 1차:** a separate on-device copy of room content. `LocalTransport` is already on the device and the trial store keeps its own cache, so this lands with the 2단계 transport.
