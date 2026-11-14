// The promise between the app and whatever carries its ops.
//
// The app only ever talks to these shapes. `LocalTransport` and
// `ClaudeTransport` implement them today; the public deployment adds another.

/**
 * @typedef {Object} Peer
 * @property {string} key      one open screen
 * @property {boolean} isMe
 * @property {object} state    what that screen last told us (who, where the caret is)
 */

/**
 * @typedef {Object} RoomChannel
 * @property {() => Promise<string[]>} docs                         ids of the docs this room has
 * @property {(docId: string) => Promise<object[]>} load            every stored op of one doc
 * @property {(docId: string, ops: object[]) => Promise<void>} append  store and pass on; safe to repeat
 * @property {(fn: (docId: string, ops: object[]) => void) => () => void} subscribe  ops from other screens; may repeat, may include my own
 * @property {(state: object) => void} setPresence
 * @property {(fn: (peers: Peer[]) => void) => () => void} onPresence
 * @property {(fn: (status: "online" | "offline") => void) => () => void} onStatus
 * @property {() => void} close
 */

/**
 * @typedef {Object} Transport
 * @property {(room: {id: string, kind: string, name: string}) => Promise<void>} createRoom
 * @property {(roomId: string) => Promise<RoomChannel | null>} openRoom  null when the room does not exist
 * @property {() => Promise<{id: string, kind: string, name: string}[]>} listRooms
 * @property {() => object} info   facts for the diagnostics panel
 */

export class Emitter {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, data) {
    for (const fn of [...(this.handlers.get(type) || [])]) {
      try {
        fn(data);
      } catch (err) {
        console.error(err);
      }
    }
  }
}
