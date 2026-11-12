// The list of devices this one can send to, with a status dot for each,
// and the one-line "session" summary. The wording lives here so it is easy to test.
export const STATE_LABEL = {
  ready: "Ready",
  busy: "Busy",
  blocked: "Needs attention",
  offline: "Offline",
};

// A device that has not sent a heartbeat recently is not in the list, so it is offline.
export const stateOf = (presence, id) => presence[id] || "offline";

// Why this device cannot be used right now (null when it can).
export function issueFor(peer, state) {
  if (state === "ready") return null;
  if (state === "busy") return `${peer.name} is busy with another transfer. Try again in a moment.`;
  if (state === "blocked") return `${peer.name} is open but cannot receive yet. On that computer, tap "Allow folder access".`;
  return `${peer.name} is offline. Open Vault on it and keep the page open.`;
}

// { state, text } for the session dot: this device and the chosen one.
export function sessionSummary({ role, peer, peerState, ownState }) {
  if (!peer) return { state: "offline", text: role === "desktop" ? "No phone paired yet" : "No computer set up yet" };
  if (ownState === "blocked") return { state: "blocked", text: "Allow folder access on this computer to receive files." };
  if (ownState === "busy") return { state: "busy", text: "Busy with a transfer" };
  if (peerState === "ready") return { state: "ready", text: `Session active with ${peer.name}` };
  return { state: peerState, text: issueFor(peer, peerState) };
}

// Whether a dragged file may be dropped right now, and the sentence to show about it.
// Files can only be sent from a computer, to a device that is ready, and one transfer at a time.
export function dropState({ role, peer, peerState, ownState, busy }) {
  if (role !== "desktop") return { ok: false, message: "Files are sent from your computer." };
  if (!peer) return { ok: false, message: "Pair a phone to send files to first." };
  if (busy || ownState === "busy") return { ok: false, message: "Wait for the current transfer to finish." };
  if (ownState === "blocked") return { ok: false, message: "Allow folder access on this computer first." };
  if (peerState !== "ready") return { ok: false, message: issueFor(peer, peerState) };
  return { ok: true, message: `Drop to send to ${peer.name}` };
}

// Draws the list. Click a row to choose who files go to (only when there is more than one).
// Pass onRemove to show a Remove button on every row.
export function renderPeers(list, { peers, presence, selectedId, onSelect, onRemove }) {
  list.replaceChildren();
  for (const peer of peers) {
    const state = stateOf(presence, peer.id);

    const item = document.createElement("li");
    item.className = "peer";
    item.dataset.selected = String(peer.id === selectedId);
    item.dataset.pick = String(peers.length > 1);

    const dot = document.createElement("i");
    dot.className = "dot";
    dot.dataset.state = state;
    dot.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.textContent = peer.name;

    const label = document.createElement("small");
    label.textContent = STATE_LABEL[state];

    item.append(dot, name, label);
    if (peers.length > 1) item.addEventListener("click", () => onSelect(peer.id));

    if (onRemove) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn danger small";
      button.textContent = "Remove";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onRemove(peer);
      });
      item.append(button);
    }
    list.append(item);
  }
}