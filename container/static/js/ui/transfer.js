import { $ } from "./dom.js";
import { celebrate } from "../scene/scene.js";

// The message shown while files move: "loading", "received" or "interrupted".
//   showTransfer("loading", "Preparing the connection", "", 0.4)
//   showTransfer("received", "Received 12 files", "Saved to Vault Inbox")
//   showTransfer("interrupted", "Transfer interrupted", "The phone went offline")
export function showTransfer(state, title, detail = "", progress = null, resumable = true) {
  // Celebrate once, when a transfer first flips to "received" (not on every repeat of the same message).
  const fresh = state === "received" && ($("transfer").hidden || $("transfer").dataset.state !== "received");
  $("transfer").dataset.state = state;
  $("transfer-title").textContent = title;
  $("transfer-detail").textContent = detail;
  // Setting a style property from script is allowed by our CSP; an inline style attribute is not.
  $("transfer-bar").style.width = progress === null ? "" : `${Math.round(progress * 100)}%`;
  $("transfer-resume").hidden = !(state === "interrupted" && resumable);
  $("transfer-cancel").hidden = !(state === "loading" || (state === "interrupted" && resumable));
  $("transfer").hidden = false;
  if (fresh) celebrate();
}


export function hideTransfer() {
  $("transfer").hidden = true;
}

export function onTransferCancel(handler) {
  $("transfer-cancel").addEventListener("click", handler);
}

export function onTransferResume(handler) {
  $("transfer-resume").addEventListener("click", handler);
}
