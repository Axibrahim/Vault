import { api } from "../core/api.js";
import { withReauth } from "../core/auth.js";
import { $, setStatus, show } from "../ui/dom.js";

// What the screen says, depending on who is looking at it.
const COPY = {
  computer: {
    eyebrow: "Another door is open",
    title: "Already set up elsewhere",
    lead: "This account is set up on another computer, or this browser's data was cleared. Remove the old computer below to set up this one.",
  },
  phone: {
    eyebrow: "Another door is open",
    title: "A phone is already paired",
    lead: "This account already has a paired phone, or this browser's data was cleared. Remove the old one below to pair this phone instead.",
  },
  needComputer: {
    eyebrow: "One step first",
    title: "Set up your computer first",
    lead: "Vault saves your files into a folder on your computer, so the computer has to be set up before a phone can join. Open Vault on your computer (Chrome or Edge), sign in with this same Google account, and finish the setup. Then come back to this phone.",
  },
};

// An account that is set up elsewhere (or this browser's data was cleared),
// or a phone that opened Vault before the computer was set up.
// `mode` is "computer", "phone" or "needComputer".
export function showOther(devices, refresh, mode = "computer") {
  const copy = COPY[mode] || COPY.computer;
  $("other-eyebrow").textContent = copy.eyebrow;
  $("other-title").textContent = copy.title;
  $("other-lead").textContent = copy.lead;

  const list = $("device-list");
  list.replaceChildren();

  for (const device of devices.filter((d) => d.status === "active")) {
    const item = document.createElement("li");
    item.textContent = `${device.name} (${device.type}) `;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn danger small";
    button.textContent = "Remove";
    button.addEventListener("click", async () => {
      if (!confirm(`Remove "${device.name}" from your Vault account?`)) return;
      try {
        await withReauth(() => api("POST", `/api/devices/${device.id}/revoke`));
      } catch (err) {
        setStatus("Could not remove that device");
        return;
      }
      await refresh();
    });

    item.appendChild(button);
    list.appendChild(item);
  }
  show("other");
}