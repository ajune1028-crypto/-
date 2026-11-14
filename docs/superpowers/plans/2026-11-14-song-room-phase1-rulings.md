# Song room phase 1 and skeleton: decisions made while building (2026-11-14)

Every decision taken on the owner's behalf in this session, in the order made. Each line ends with what it costs if the decision turns out wrong.

## Setup

- Ruling: the zip's project went to the repository root with its git history; docs/superpowers/source (raw words, reference images) was filtered out of that history and is gitignored, because the repository is public and CLAUDE.md says to ask before publishing it — cost if wrong: the next session lacks the raw words until the owner says yes; the specs summarise them.
- Ruling: the owner asked for code, not a design conversation ("뼈대 잡아줘", "코드 짜고 보고"), so the brainstorming approval gate was skipped; decisions are recorded here instead, as the earlier sessions did — cost if wrong: a choice the owner would have made differently, found when reading this file.
- Ruling: no subagents; self-review only (the owner did not ask for them) — cost if wrong: author blind spots.

## Analysis (voice to notes)

- Ruling: YIN pitch on 16 kHz audio, 10 ms hop, 25 ms window, 65–1050 Hz, done in plain JavaScript on the main thread (about 2 s per minute of 48 kHz audio; a live take costs a few per cent of a core) — cost if wrong: long imports stall; moving it into a Worker is self-contained.
- Ruling: note splitting follows the song spec's numbers (0.6 semitone for 60 ms, notes under 80 ms joined or dropped) plus: a loudness dip below 0.45 of both sides splits (라-라); vibrato pieces that alternate direction around one pitch, with short middles (≤130 ms) and steps ≤3 semitones, are joined back into one note — cost if wrong: very fast alternating melodies (8 notes a second) would merge.
- Ruling: loudness for dip detection is measured over two whole voice periods, not the 25 ms window — the window flattened 'l' dips; vibrato swells still stay above the line (measured 0.55 vs 0.33) — cost if wrong: deep tremolo could split a note.
- Ruling: onset shift 0 after measuring 72 synthetic notes (bias −0.6 ms, worst 12.5 ms) — cost if wrong: real voices may need a few ms; re-measure with real takes.
- Ruling: glide fragments are held on the previous note (legato) rather than starting the next note early, so the next note's start stays exact — cost if wrong: the previous note sounds a little longer than sung.
- Ruling: one cold-start run of Chrome's fake microphone split a held note once; four reruns were clean, so the threshold was not changed and the risk is listed in CLAUDE.md — cost if wrong: real dropouts on phones may split held notes.

## Song document

- Ruling: all song times are whole milliseconds; notes are stored inside the sound's op as [t, d, p, v·100] arrays — compact enough for the trial store's 48 KB chunks (3 minutes ≈ 12 KB of notes) — cost if wrong: none.
- Ruling: clip fields are per-field last-writer-wins; removal is the text room's removes counter; clips placed on the same spot at once are drawn a row apart by id order, computed at view time (stored rows never change by themselves) — cost if wrong: none.
- Ruling: undo atoms for the song are add/del/set; sources are never undone (they are invisible without clips) — cost if wrong: an unused sound stays in the document.

## Sound

- Ruling: the piano is synthesised per key into buffers (stiff partials, two detuned strings, two-stage decay, hammer knock) at 24 kHz, plus a generated room echo; 밝게 = more partials and knock, less echo; 어둡게 = rounded partials, more echo. The spec's word was 부드럽게; the owner said 어둡게, so the label is 어둡게 — cost if wrong: one label.
- Ruling: the piano tone and 원본/피아노 are device settings, as the spec says — cost if wrong: none.
- Ruling: playback books 250 ms ahead every 40 ms on the audio clock; in 원본 mode a clip whose recording is not on this device plays as piano — cost if wrong: none.
- Ruling: recordings are kept as 24 kHz 16-bit WAV in IndexedDB on the recording device; imports are decoded by the browser and re-kept the same way — cost if wrong: about 2.9 MB per minute on the device.
- Ruling: latency compensation (base + output + input latency + the 싱크 보정 setting) is applied only when other clips were playing during the take — cost if wrong: a take recorded alone might sit a few ms late; it does not matter until something plays with it.

## Screen

- Ruling: rows are 5.25 rem tall; note bars may be taller than a semitone step (one voice sings one note at a time, so bars never sit side by side) so the 도레미 names fit; each sound has a fixed pitch window of at least 10 semitones so a cut clip keeps its bar heights — cost if wrong: very wide melodies look flatter.
- Ruling: a tap on a clip chooses it and opens its menu; a second tap closes it; hold 380 ms then drag moves it; a drag without holding scrolls (clips handle panning themselves, since touch-action must be none on them for the hold) — cost if wrong: one more tap.
- Ruling: the record button gives way to 소리 가져오기 where there is no microphone; with a microphone, importing is in the settings sheet, as the spec says — cost if wrong: one more step to import on phones. (Replaced in the second round below: the record button always shows, and the toolbar's 소리 넣기 offers all three ways in.)
- Ruling: copy puts the clip on a device-wide clipboard, so it pastes into other song rooms too (the sound's notes and waveform travel; the recording stays on the device) — the first piece of "moving work between rooms" — cost if wrong: none.
- Ruling: "음 보기" lists each note with its name, start and length to 0.01 s, and plays a note when tapped — this answers "0.5초인지 0.4초인지" directly — cost if wrong: none. (In the second round the list moved under 음 편집's piano roll; the menu item 음 보기 is gone.)

## Skeleton

- Ruling: room kinds live in ui/kinds.js; a kind without a screen shows 준비 중 on home, and a room of a kind this version cannot open says so — cost if wrong: none.
- Ruling: RoomSession routes documents through a DOC_TYPES table (room, s:<day>, song, k:<day>) — cost if wrong: none.
- Ruling: the room frame gives each screen a row under the bar (frame.top) and a settings hook (mount returns { close, settings }) — cost if wrong: none.

## Look

- Ruling: dark mode is near-black graphite (paper #0b0b0e, base #020204) with deep, quiet colour fields and neutral smoky glass; the light theme keeps the blue glass the owner approved on 13 November — cost if wrong: one more token pass.
- Ruling: "글라스 + 그라데이션, 진한 색은 중요한 기능에" is read as: in dark mode small actions (저장, 코드 복사, chosen states) are glass tinted with the accent, and the one main action of a sheet keeps a deep blue-into-violet gradient; light mode gets the same gradient on main buttons — cost if wrong: token values only.
- Ruling: "색을 자기가 정하고 다크·라이트에서 안 바뀌게" is read as the app's accent colour per device, written on the page itself so both themes use it unchanged; icons in that colour are nudged only when they would not show (3:1) on a paper. Members' text colours keep their per-theme lightness (4.5:1 rule); choosing them freely is roadmap 7 — cost if wrong: the owner meant text colours; then roadmap 7 is next.
- Ruling: 글자 크기 scales the writing (sheets) only, not the whole interface, because the layout is a 360-wide rem column that would overflow — cost if wrong: UI text stays the same size.

## Drawing and publishing

- Ruling: strokes live in their own document per day (k:<day>) with InkDoc, not inside the sheet, so the photo room and whiteboard reuse it; points are hundredths of a rem from the sheet's corner, anchored to the sheet, not to lines yet — cost if wrong: drawings drift when text above them grows (roadmap 6).
- Ruling: the browser test driver brings a page to the front before a drag: Chrome hands mouse moves to a background page only on its frames (a drawing scenario took 85 s before, 1.9 s after) — cost if wrong: none.
- Ruling: on a page with no Claude runtime and no ?dev, rooms are device-only and home says "아직 서버가 없어서 방은 이 기기에만 있어요"; before, such rooms offered an invitation that could not open elsewhere — cost if wrong: none.
- Ruling: GitHub Pages deploys from main only (the github-pages environment's default); the owner turns Pages on and merges — cost if wrong: none.

## Second round (owner's message of 14 November, evening)

- Ruling: "녹음 기능을 안 만들어" came from the Claude trial page, which may not use the microphone; the record button is now always shown and, where the page cannot record, explains why and offers the phone's own recorder app through `<input type=file accept="audio/*" capture>` (Android opens Samsung 녹음 or the default recorder) — cost if wrong: none; in-app recording still works on https pages.
- Ruling: file pickers are opened by `<label for>` only, never by a script after an await (some phones and app views refuse a chooser that is not straight from a tap), and importing no longer waits for the audio to wake (some views never answer resume()) — cost if wrong: none.
- Ruling: phone formats are tested with real files: m4a (AAC, what Samsung 녹음 saves), mp3 and webm made by ffmpeg in the scenario runner; skipped where ffmpeg is missing — cost if wrong: none.
- Ruling: "직사각형을 잇고" is read as joining a clip with the next one on its row (GarageBand's Join): pieces of one recording merge back; other pairs become one clip of a new combined sound, the gap kept as silence — cost if wrong: the owner meant playback-order lines (that is the whiteboard's 잇기, roadmap 9).
- Ruling: "음편집" is a piano-roll editor; edits are ops over a sound's notes (nfix/nadd), so they reach every clip cut from that recording — cost if wrong: per-clip note edits would need a copy of the sound first.
- Ruling: two fingers zoom time sideways and row height up and down; on a computer the plain wheel zooms (as asked: "PC는 스크롤 하면 되게"), Shift+wheel moves sideways, Alt+wheel heightens rows, a mouse drag on empty space pans — cost if wrong: people expecting the wheel to scroll use Shift.
- Ruling: landscape is "width more than 1.05 × height"; then the scale follows the height (0.85–1.25) and the app takes the width up to 75 rem; writing sheets stay a 22.5 rem column so drawings do not move — cost if wrong: none.
- Ruling: speeds are 1, 1.5, 2, 3, 0.5 (one button cycles); recordings are time-stretched with WSOLA so the pitch stays; stretching is done once per sound and speed when first played — cost if wrong: a one-off pause of up to a second for a long take at a new speed.
- Ruling: the area eraser (부분) is the default and is a stroke drawn with destination-out; the stroke eraser (획) hides whole strokes; brushes are pen, pencil (grain), marker, highlighter; both choices are remembered per device — cost if wrong: none.
- Ruling: "파란 글라스를 빨주노초파남보갈핑으로" makes the glass itself follow the chosen colour: one --tint (the accent) drives the glass gradient, shadows, the sheet rim, the sky under both halves and the ground; presets are 빨강 주황 노랑 초록 파랑 남색 보라 갈색 핑크 흑백 plus any colour — cost if wrong: none.
- Ruling: a locked clip records who locked it (lockBy); they and the room's owner may unlock — cost if wrong: none.
- Ruling: the whiteboard is its own room kind with a "board" document: memo and song cards (a song card carries its sound's notes and waveform so the board plays on its own; the recording travels only when the card is a whole recording), and lines that set the playing order — at most one line in and out per card, no loops, numbered in playing order and coloured 빨주노초파남보검 in turn; unjoined cards play from the leftmost — cost if wrong: none.
- Ruling: 잇기 on the board is "tap cards one after another" (the original idea's numbered taps), not a freehand brush; a freehand order brush can be added on top — cost if wrong: one more input mode.
- Ruling: 보내기 opens the chosen whiteboard's session in the background, adds the card and closes it after the store has it — cost if wrong: none.
- Ruling: 레퍼런스 starts as private notes kept on the device only (never synced, so nobody else can see them), with 이 방에 붙이기 for text rooms and boards and a settings switch that hides it everywhere — cost if wrong: notes do not follow the person to another device until the server exists.

## Final check (14 November, night)

- Ruling: two fingers always mean zoom, never an edit. A second finger landing cancels whatever the first began (a clip's hold or scroll, a note's move or stretch, a card's move, a time-bar scrub) without saving, and the lifts that end a pinch are no taps or double taps. One helper, ui/fingers.js (watchFingers), serves the timeline, 음 편집 and the whiteboard; every one-finger gesture follows only its own pointerId. Found by testing with real touch events: before, a pinch on a rectangle scrolled from the wrong finger (104 px off with one thumb held still), a pinch on notes stopped after one step, pinching in on empty roll space added a note, and a pinch on cards moved them or made an order line — cost if wrong: none.
- Ruling: 음 편집 keeps its keys, row stripes and notes from one draw to the next and only moves them, as the timeline already did for clips: a touch stays with the element it began on, so an element replaced under a finger stops reaching the roll — cost if wrong: none.
- Ruling: on the whiteboard, 잇기 counts a tap (lifted without moving), not a touch, so a pinch that starts on a card joins nothing — cost if wrong: none; mouse clicks behave as before.
- Ruling: a drawn line belongs to the finger or pen that began it; a resting palm or a second finger is left out (before, it threw the line away and joined both fingers into a zigzag). Two-finger scrolling while the pen is on is not offered yet; turning the pen off scrolls — cost if wrong: someone wanting to scroll mid-drawing turns the pen off first.
- Ruling: the timeline and the piano roll select no text (user-select: none, no touch callout), so a long press picks a clip or a note up instead of selecting its name, which cancels the touch on phones — cost if wrong: none; nothing there is text to copy.
- Ruling: the test driver drives fingers through Input.dispatchTouchEvent (page.touch, page.pinch), which passes Chrome's own touch path, so pointer and touch events arrive in a phone's order; a real phone's long press was not checked by a person — cost if wrong: a phone-only long-press quirk would show up only on the device.
