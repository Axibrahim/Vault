// The wording of the Settings panel. Plain functions with no page access, so they are easy to test.
import { formatBytes } from "../transfer/safety.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "E" for eliza@example.com, shown in the round badge next to the account.
export const initialOf = (email) => (String(email || "").trim().charAt(0) || "?").toUpperCase();

// "just now", "5 min ago", "2 h ago", "3 d ago", or the date once it is more than a week old.
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return "unknown";
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString([], { dateStyle: "medium" });
}

// A date and time for the Security tab, or "unknown" when the server did not know it.
export function fullTime(iso) {
  return iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "unknown";
}

export function describeDevice(device, myId, now = Date.now()) {
  return {
    name: device.name,
    kind: device.type === "phone" ? "Phone" : "Computer",
    mine: device.id === myId,
    added: `Added ${relativeTime(device.createdAt, now)}`,
    fingerprint: device.fingerprint,
  };
}

// What the Remove button asks before it does anything.
export function removalWarning(device, mine, lastComputer) {
  if (mine) return `Remove this ${device.type === "phone" ? "phone" : "computer"}? You will have to set it up again.`;
  if (device.type === "desktop" && lastComputer) return "This is your last computer. Removing it also removes your phones.";
  return `Remove ${device.name}? It will stop working with Vault straight away.`;
}

// One line above the activity list: how much moved in the last 30 days.
export function summarizeActivity(items, myId) {
  if (items.length === 0) return "No transfers in the last 30 days.";
  const total = plural(items.length, "transfer");
  if (!myId) return `${total} in the last 30 days.`;

  let sent = 0;
  let received = 0;
  for (const item of items) {
    if (item.fromId === myId) sent += item.bytes;
    else received += item.bytes;
  }
  return `${total} in the last 30 days: ${formatBytes(sent)} sent, ${formatBytes(received)} received.`;
}

// One row of the activity list. `myId` is this device; without it we can only say who sent to whom.
export function describeTransfer(item, myId) {
  const detail = `${plural(item.files, "file")} · ${formatBytes(item.bytes)}`;
  if (!myId) return { title: `${item.fromName} to ${item.toName}`, detail };
  const sent = item.fromId === myId;
  return { title: `${sent ? "Sent to" : "Received from"} ${sent ? item.toName : item.fromName}`, detail };
}