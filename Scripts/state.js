// state.js — Local state management (never shared on DHT)
// TODO(ux): Add export/import for state (favorites, blocks, history) to backup or transfer between devices
// TODO(ux): Add statistics tracking (total conversations, total time, average duration)

window.Decengle = window.Decengle || {};

const STATE = {
  IDLE: "idle",
  SEARCH: "search",
  BUSY: "busy",
};

class LocalState {
  constructor() {
    this.status = STATE.IDLE;
    this.favs = this._load("decengle_favs") || [];
    this.blocked = this._load("decengle_blocked") || [];
    this.history = this._load("decengle_history") || [];
    this.listeners = [];
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  setStatus(status) {
    this.status = status;
    this._emit();
  }

  addFav(peerId) {
    if (!this.favs.includes(peerId)) {
      this.favs.push(peerId);
      this._save("decengle_favs", this.favs);
    }
  }

  removeFav(peerId) {
    this.favs = this.favs.filter((id) => id !== peerId);
    this._save("decengle_favs", this.favs);
  }

  block(peerId) {
    // TODO(ux): Store block timestamp so blocks can auto-expire after N days
    // TODO(ux): Add an optional block reason (for user's own reference)
    if (!this.blocked.includes(peerId)) {
      this.blocked.push(peerId);
      this._save("decengle_blocked", this.blocked);
    }
  }

  unblock(peerId) {
    this.blocked = this.blocked.filter((id) => id !== peerId);
    this._save("decengle_blocked", this.blocked);
  }

  isBlocked(peerId) {
    return this.blocked.includes(peerId);
  }

  addHistory(entry) {
    // entry: { peerId, timestamp, duration }
    // TODO(ux): Track conversation duration (set startTime on match, compute duration on end)
    // TODO(ux): Allow deleting individual history entries
    this.history.push(entry);
    // Keep last 100 entries
    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }
    this._save("decengle_history", this.history);
  }

  _save(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch {
      // localStorage not available or full
    }
  }

  _load(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}

Decengle.LocalState = LocalState;
Decengle.STATE = STATE;
