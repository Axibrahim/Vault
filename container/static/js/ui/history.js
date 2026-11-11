// The Activity tab in Settings: what was sent and received on this account in the last 30 days.
import { api } from "../core/api.js";
import { $ } from "./dom.js";
import { describeTransfer, relativeTime, summarizeActivity } from "./settings-format.js";

const settingsIsOpen = () => document.body.dataset.panel === "settings";

export async function loadHistory(myId) {
  if (!settingsIsOpen()) return;              // nobody is looking at the list, so do not ask for it
  let items;
  try {
    ({ history: items } = await api("GET", "/api/transfers/history"));
  } catch (err) {
    return;                                   // keep whatever is shown
  }
  if (!settingsIsOpen()) return;              // the person closed Settings while we were loading

  const list = $("history-list");
  list.replaceChildren();
  items.forEach((item, index) => {
    const { title, detail } = describeTransfer(item, myId);
    const row = document.createElement("li");
    row.style.setProperty("--i", String(Math.min(index, 8)));
    const text = document.createElement("span");
    text.textContent = title;
    const meta = document.createElement("small");
    meta.textContent = `${detail} · ${relativeTime(item.at)}`;
    row.append(text, meta);
    list.append(row);
  });
  $("history-empty").hidden = items.length > 0;
  $("history-summary").textContent = summarizeActivity(items, myId);
}