import { $ } from "./dom.js";

// The message shown while files move: "loading", "received" or "interrupted".
//   showTransfer("loading", "Preparing the connection", "", 0.4)
//   showTransfer("received", "Received 12 files", "Saved to Vault Inbox")
//   showTransfer("interrupted", "Transfer interrupted", "The phone went offline")
export function showTransfer(state, title, detail = "", progress = null) {
  $("transfer").dataset.state = state;
  $("transfer-title").textContent = title;
  $("transfer-detail").textContent = detail;
  // Setting a style property from script is allowed by our CSP; an inline style attribute is not.
  $("transfer-bar").style.width = progress === null ? "" : `${Math.round(progress * 100)}%`;
  $("transfer-resume").hidden = state !== "interrupted";
  $("transfer").hidden = false;
}

export function hideTransfer() {
  $("transfer").hidden = true;
}

export function onTransferResume(handler) {
  $("transfer-resume").addEventListener("click", handler);
}