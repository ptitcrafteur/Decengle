// state.js — Local state management (never shared on DHT)

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
