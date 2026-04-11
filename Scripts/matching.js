// matching.js — Random matching service
// Finds a random peer in "search" state and initiates a connection
// TODO(ux): Add interest tags / topics — users can set interests and prefer peers with matching tags
// TODO(ux): Add optional language preference for matching
// TODO(robustness): Add handshake timeout — if match-accept not received within N seconds, retry

window.Decengle = window.Decengle || {};

class MatchingService {
  constructor(dht, localState) {
    this.dht = dht;
    this.localState = localState;
    this.currentMatch = null;
    this.searchInterval = null;
    this.onMatchFound = null;
    this.onMatchEnded = null;
  }

  // Start looking for a random peer
  startSearching() {
    this.localState.setStatus(Decengle.STATE.SEARCH);
    // Announce we're searching in the DHT
    this.dht.announce({ state: "search" });

    // Periodically look for other searchers
    this.searchInterval = setInterval(() => {
      this._tryMatch();
    }, 2000);

    // TODO(robustness): Add a maximum search duration — notify user after N minutes with no match
    // Also try immediately
    this._tryMatch();
  }

  async _tryMatch() {
    if (this.localState.status !== Decengle.STATE.SEARCH) {
      this.stopSearching();
      return;
    }

    // Re-announce availability
    this.dht.announce({ state: "search" });

    const searchers = await this.dht.findSearchingPeers();

    // Filter out blocked peers
    const candidates = searchers.filter(
      (s) => !this.localState.isBlocked(s.peerId)
    );

    if (candidates.length === 0) return;

    // Pick a random one
    // TODO(robustness): Prevent matching the same peer twice in quick succession (add cooldown per peer ID)
    // TODO(robustness): Handle the glare case where both peers send match-request to each other simultaneously
    const match = candidates[Math.floor(Math.random() * candidates.length)];
    this._initiateMatch(match.peerId);
  }

  _initiateMatch(peerId) {
    this.stopSearching();
    this.currentMatch = peerId;
    this.localState.setStatus(Decengle.STATE.BUSY);

    // Announce we're busy now
    this.dht.announce({ state: "busy", matchedWith: peerId });

    // Notify the matched peer via DHT data channel
    this.dht.sendTo(peerId, {
      type: "match-request",
      peerId: this.dht.peerId,
    });

    if (this.onMatchFound) this.onMatchFound(peerId);
  }

  handleMatchRequest(fromPeerId) {
    if (this.localState.status !== Decengle.STATE.SEARCH) {
      // Not available — decline
      this.dht.sendTo(fromPeerId, {
        type: "match-decline",
        peerId: this.dht.peerId,
      });
      return;
    }

    if (this.localState.isBlocked(fromPeerId)) {
      this.dht.sendTo(fromPeerId, {
        type: "match-decline",
        peerId: this.dht.peerId,
      });
      return;
    }

    // Accept match
    this.stopSearching();
    this.currentMatch = fromPeerId;
    this.localState.setStatus(Decengle.STATE.BUSY);
    this.dht.announce({ state: "busy", matchedWith: fromPeerId });

    this.dht.sendTo(fromPeerId, {
      type: "match-accept",
      peerId: this.dht.peerId,
    });

    if (this.onMatchFound) this.onMatchFound(fromPeerId);
  }

  // "Next" — end current match, start searching again
  next() {
    if (this.currentMatch) {
      this.dht.sendTo(this.currentMatch, {
        type: "match-ended",
        peerId: this.dht.peerId,
      });

      this.localState.addHistory({
        peerId: this.currentMatch,
        timestamp: Date.now(),
      });
    }

    const previousMatch = this.currentMatch;
    this.currentMatch = null;

    if (this.onMatchEnded) this.onMatchEnded(previousMatch);

    // Auto-start searching again
    this.startSearching();
  }

  // Completely stop (go idle)
  stop() {
    if (this.currentMatch) {
      this.dht.sendTo(this.currentMatch, {
        type: "match-ended",
        peerId: this.dht.peerId,
      });
      this.localState.addHistory({
        peerId: this.currentMatch,
        timestamp: Date.now(),
      });
    }
    this.currentMatch = null;
    this.stopSearching();
    this.localState.setStatus(Decengle.STATE.IDLE);
    this.dht.announce({ state: "idle" });
    if (this.onMatchEnded) this.onMatchEnded(null);
  }

  stopSearching() {
    if (this.searchInterval) {
      clearInterval(this.searchInterval);
      this.searchInterval = null;
    }
  }

  handleMatchEnded(fromPeerId) {
    if (this.currentMatch === fromPeerId) {
      this.localState.addHistory({
        peerId: this.currentMatch,
        timestamp: Date.now(),
      });
      this.currentMatch = null;
      if (this.onMatchEnded) this.onMatchEnded(fromPeerId);
      // TODO(ux): Auto-restart searching after match ends (instead of going idle) — make this configurable
      this.localState.setStatus(Decengle.STATE.IDLE);
    }
  }
}

Decengle.MatchingService = MatchingService;
