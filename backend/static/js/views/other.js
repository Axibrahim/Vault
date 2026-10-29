import { api } from "../core/api.js";
import { $, setStatus, show } from "../ui/dom.js";

// An account that is set up on another computer (or this browser's data was cleared).
export function showOther(devices, refresh) {
  const list = $("device-list");
  list.replaceChildren();

  for (const device of devices.filter((d) => d.status === "active")) {
    const item = document.createElement("li");
    item.textContent = device.name + " ";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn danger small";
    button.textContent = "Remove";
    button.addEventListener("click", async () => {
      if (!confirm(`Remove "${device.name}" from your Vault account?`)) return;
      try {
        await api("POST", `/api/devices/${device.id}/revoke`);
      } catch (err) {
        setStatus("Could not remove that computer");
        return;
      }
      await refresh();
    });

    item.appendChild(button);
    list.appendChild(item);
  }
  show("other");
}