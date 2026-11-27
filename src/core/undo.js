// My own steps, most recent last. Other people's changes never enter here.

export class UndoStack {
  constructor(limit = 100, mergeMs = 1000) {
    this.limit = limit;
    this.mergeMs = mergeMs;
    this.done = [];
    this.undone = [];
  }

  /**
   * `typing` steps that follow each other within `mergeMs` become one step; steps of one `group` (the
   * parts of one line drawn in pieces) are one step whatever the time between them.
   */
  record(atoms, { now, typing, group = null }) {
    if (!atoms.length) return;
    const top = this.done[this.done.length - 1];
    if ((group && top && top.group === group) || (typing && top && top.typing && now - top.at < this.mergeMs)) {
      top.atoms.push(...atoms);
      top.at = now;
    } else {
      this.done.push({ atoms: atoms.slice(), at: now, typing: !!typing, group });
      if (this.done.length > this.limit) this.done.shift();
    }
    this.undone.length = 0;
  }

  undo() {
    const step = this.done.pop();
    if (!step) return null;
    step.typing = false;
    const top = this.done[this.done.length - 1];
    if (top) top.typing = false;
    this.undone.push(step);
    return step.atoms;
  }

  redo() {
    const step = this.undone.pop();
    if (!step) return null;
    this.done.push(step);
    return step.atoms;
  }

  get canUndo() {
    return this.done.length > 0;
  }

  get canRedo() {
    return this.undone.length > 0;
  }
}
