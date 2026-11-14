# Text room, phase 1: decisions made while building

Every decision taken on the owner's behalf while carrying out `2026-11-12-text-room-phase1.md`, in the order made.
Each line ends with what it costs if the decision turns out wrong.

## Rulings

- Setup: Ruling: no separate worktree; work in place on branch feat/text-room-phase1 — the repo is a fresh single-purpose checkout in a private workspace and the user said not to ask — cost if wrong: none, nothing else shares this checkout.
- Setup: Ruling: final review will be a self-review — the user did not ask for subagents and the session is told not to spawn them unasked — cost if wrong: author blind spots stay until the user or a later reviewer looks.
- Setup: Ruling: a task brief is re-read only when the plan text is no longer verbatim in context — the plan was written in this session and briefs are extracts of it — cost if wrong: a missed value, caught by the task's tests.
- Task 1: Ruling: Sheet exposes indexAfter(id) and isVisible(id) instead of indexOfId(id) — callers only ever need the caret position after a char — cost if wrong: one rename.
- Task 1: Ruling: the suite command is 'node --test' (auto-discovery), not 'node --test tests/' — Node 22 treats the directory argument as a module and fails — cost if wrong: none.
- Task 2: Ruling: added Sheet.maxN and Clock.atLeast(n); every op-making function first lifts the clock to the sheet's highest counter — an insert whose id is not above the sheet's ids lands in the wrong place — cost if wrong: none, ids only grow faster.
- Task 4: Ruling: added memberOps(clock, memberId, fields) beside createRoomOps/joinOps — renaming, recolouring and setting a code need it — cost if wrong: none.
- Task 5: Ruling: LocalTransport rejects append/load/docs while offline instead of storing silently — that is how a real dropped connection behaves and it exercises the session's outbox and retry — cost if wrong: none, test-only behaviour.
- Task 5: Ruling: RoomSession creates its own Clock(newReplicaId()) unless given one, and takes retry delays as an option — two tabs must never share a replica id; tests need short delays — cost if wrong: none.
- Task 6: Ruling: a view's first snapshot is recorded but not pushed through subscribe — history is read with load(), otherwise opening a room would load every day sheet at once — cost if wrong: none, later snapshots still deliver.
- Task 6: Ruling: a burst needing more than 20 live messages skips the live channel and travels through the store only — the channel budget is about 40 messages a second shared with presence — cost if wrong: a large paste appears on the other screen after the store write instead of at once.
- Task 7: Ruling: sizes are in rem and the root font size is scaled by clamp(width/360, 1, 1.4), instead of CSS zoom — standard CSS, same result — cost if wrong: none.
- Task 7: Ruling: the session that created a room is handed to the room view (app.handoff) instead of being reopened — avoids a second open and a resend — cost if wrong: none.
- Task 7: Ruling: test device stores are prefixed with both dev and ns — a remembered code from one scenario leaked into the next — cost if wrong: none, test-only parameters.
- Task 8: Ruling: the layers check compares heights for eleven kinds of text, not per-line pixel positions — a textarea cannot report where its lines sit; equal height under identical CSS means equal wrapping — cost if wrong: a same-height, different-wrap case would slip through.
- Task 8: Ruling: the draw layer is one block per line with word spans inside — empty lines and line ends become measurable for carets and stamps — cost if wrong: none.
- Task 8: Ruling: undo atoms carry their doc id so one stack serves every day sheet — cost if wrong: none.
- Order: Ruling: Task 10 (bundle and publish) runs before Task 9 (design pass, error states), then the page is republished — the user reads this tomorrow and a working link matters more than the order of polish — cost if wrong: one extra publish.
- Task 9: Ruling: the column may shrink to 0.8 on screens narrower than 360 — the plan's floor of 1 pushed the page sideways at 320 wide — cost if wrong: text below 16px on very narrow iPhones makes Safari zoom on focus.
- Task 9: Ruling: the wheel's sector angles are stretched by the word's width-to-height ratio — equal angles left the first writer a sliver on wide words, against the spec's 'same size for everyone' — cost if wrong: none.
- Task 9: Ruling: member colours are ordered coral, blue, green, violet, orange, teal, pink, olive — the first few people to join should look clearly different — cost if wrong: none.
- Task 9: Ruling: a double tap mixes only while colours are on — with colours off nothing would be visible — cost if wrong: none.
- Task 9: Ruling: several Task 9 checks passed on first run because Tasks 7 and 8 had already built the behaviour (contrast, motion, slow start, no store, new version, diagnostics, wide, stamp tap, speed); they stay as regression pins — cost if wrong: none.
- Debug: Ruling: harden every boundary on the way to a room, each with its own local reproduction written first (sandbox without forms; a store that refuses; a store that never answers; a live channel that never answers; an address that does not follow), give creation a device-only fallback, and put a connection trace on the home settings sheet so the next report names the cause — the alternative is shipping one guess per day — cost if wrong: more code than a single fix needs.
- Invite: Ruling: the invitation is a sheet with the link, a copy button, the room code, and (outside the trial frame, where the system share sheet exists) a send button; it opens once right after a room is made; link = page address + #r-<room>; the trial build is told its own address with --share-base — cost if wrong: one extra tap to close the sheet.
- Debug: Ruling: the hardening from the earlier guesses stays (time-limited store calls with one retry, live channel joined late, device-only fallback with banner, navigation that does not wait for the address, connection trace on home) — each has a reproduction that failed first, and the real trial runtime is still unobserved — cost if wrong: about 200 lines that only matter in views that misbehave.
- Ruling: a room made while the view has no shared store is remembered as device-only (tag 이 기기만, banner in the room, no invitation link) — a link to it could never open anywhere else — cost if wrong: none.
- Glass: Ruling: "퍼런 애플글라스" is read as: content stays solid, chrome becomes glass — the writing sheet is 92% (light) / 90% (dark) solid so all eight colours keep 4.5:1; bars, toolbar, + buttons, pill, room cards and slide-up sheets are blue-tinted frosted glass with a bright rim; primary buttons and switches are blue; the two home hues stay (일상 yellow/orange, 창작 lavender) with a sky blue under both — cost if wrong: one more restyle of tokens.
- Glass: Ruling: member colours now need 4.75:1 on plain paper (was 4.5) so that 4.5:1 still holds on the frosted sheet over the strongest field colour; text lying straight on a field uses a stronger secondary tone (--soft); dark field colours were darkened so white text reads on them — scenario "glass: …" RED→GREEN checks every pair — cost if wrong: colours a shade deeper than strictly needed.
- Test: Ruling: two scenarios placed a caret before the other screen's text had arrived (the caret rightly stays in front of text that arrives after it); they now wait for agreement first — a race in the test, not in the app — cost if wrong: none.
- Final: Ruling: the final message lists the rulings that change what the owner sees, and the complete list is committed as docs/superpowers/plans/2026-11-12-text-room-phase1-rulings.md — the owner reads on a phone and asked not to be consulted on details — cost if wrong: a decision they would have questioned goes unnoticed until they open the file.
- Finish: Ruling: the branch feat/text-room-phase1 is kept as it is, nothing merged or pushed — there is no remote and the next pieces (text room part 2, song room) continue from here — cost if wrong: none.

## The 13 November outage

- Debug: ROOT CAUSE FOUND (2026-11-13 23:10, after the user's second report: "+ 눌러도 식별 코드 같은 게 하나도 안 되고, 코드를 쳐도 쳐지는지 모르겠고, 들어가기를 눌러도 안 된다"). Measured in a real browser: every form field was position:absolute, transparent text, transparent caret, no border, stretched over the whole sheet; a press at the centre of 방 만들기 landed on #my-pin. Cause: the text room's typing layer and the form fields shared the class name `input`, and the typing layer's rules (written in Task 8, unscoped) applied to every form field. Every scenario passed because the helpers pressed with el.click() and focused by script, which skip hit-testing. The earlier guesses (submit event, store, address) were not the cause.
- Debug: fixed — typing layer renamed to .typing; scenario helpers now press at the element's centre through the browser's own hit test and fail naming what covers it; new scenario "forms: every field is a visible box that a tap reaches" RED→GREEN (light and dark; create, code, join, settings). The real presses also exposed a second fault, fixed the same way: a two-line home notice covered the ⋯ button → the notice now has its own row.

## Final review and verification

- Final review: self-review (session rules allow no reviewer agent unless the owner asks). Scope: everything since b0a72f6. No Critical or Important finding left open; the two found on the way (fields covering the forms; notice covering the settings button) were fixed RED→GREEN inside Task 10.
- Final: verified 2026-11-13 23:4x — node --test 101/101; scenarios 57/57 on the source and 57/57 on the trial build; the live artifact file has the same sha256 as that build (b18326f7…, version 1794580122-d96e); the trial's own store holds a room made at 23:19 KST with its logs (4 documents), so making a room and writing works in the real runtime.

## Deferred minors

- Final: minor (deferred): a store write that lands after the app stopped waiting can leave an empty room of the same name listed on other devices.
- Final: minor (deferred): on home the diagnostics read "실시간 채널 none" while no room is open, even when the channel is available.
- Final: minor (deferred): the top edge of the blue button is 4.2:1 against white; the label sits where it is 4.6:1 or more.
- Final: minor (deferred): in a frame that refuses storage, a reload forgets "who I am" in a room unless a personal code was set; the store's per-viewer area could keep it (needs the `user` capability).
