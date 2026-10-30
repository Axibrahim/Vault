import { api } from "../core/api.js";
import { withReauth } from "../core/auth.js";
import { getDeviceIdentity, forgetDeviceIdentity } from "../device/identity.js";
import { state } from "../state.js";
import { $, setStatus, show } from "../ui/dom.js";

// A paired phone (or second device).
export function showPhone(identity) {
  $("phone-view-name").textContent = identity.name;
  show("phone");
}

export function initPhone(refresh) {
  $("remove-self-btn").addEventListener("click", async () => {
    if (!confirm("Remove this device from your Vault account?")) return;

    const identity = await getDeviceIdentity(state.uid);
    try {
      await withReauth(() => api("POST", `/api/devices/${identity.deviceId}/revoke`));
    } catch (err) {
      setStatus("Could not remove this device");
      return;
    }
    await forgetDeviceIdentity(state.uid);
    await refresh();
  });
}