// "Last 30 days": what was sent and received on this account.
import { api } from "../core/api.js";
import { formatBytes } from "../transfer/safety.js";
import { $ } from "./dom.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function when(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function describeTransfer(item, myId) {
  const sent = item.fromId === myId;
  return {
    title: `${sent ? "Sent to" : "Received from"} ${sent ? item.toName : item.fromName}`,
    detail: `${plural(item.files, "file")} · ${formatBytes(item.bytes)}`,
  };
}

export function hideHistory() {
  $("history-box").hidden = true;
}

export async function loadHistory(myId) {
  let items;
  try {
    ({ history: items } = await api("GET", "/api/transfers/history"));
  } catch (err) {
    return;                                   // keep whatever is shown
  }
  if ($("peers-box").hidden) return;          // the person left this screen while we were loading

  const list = $("history-list");
  list.replaceChildren();
  for (const item of items) {
    const { title, detail } = describeTransfer(item, myId);
    const row = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = title;
    const meta = document.createElement("small");
    meta.textContent = `${detail} · ${when(item.at)}`;
    row.append(text, meta);
    list.append(row);
  }
  $("history-empty").hidden = items.length > 0;
  $("history-box").hidden = false;
}