import {
  signInWithGoogle,
  logout,
  logoutEverywhere,
  getRememberPreference,
  setRememberPreference,
} from "../core/auth.js";
import { $, setStatus } from "../ui/dom.js";

export function showLoginOptions() {
  $("remember").checked = getRememberPreference();
}

// refresh() re-checks the session and shows the right screen.
export function initLogin(refresh) {
  $("login-btn").addEventListener("click", async () => {
    const remember = $("remember").checked;
    setRememberPreference(remember);

    setStatus("Signing in...");
    try {
      await signInWithGoogle(remember);
      await refresh();
    } catch (err) {
      setStatus("Sign-in failed");
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    try {
      await logout();
    } finally {
      await refresh();
    }
  });

  // Ends every session of this account, in every browser and on every device.
  $("logout-all-btn").addEventListener("click", async () => {
    if (!confirm("Sign out of Vault on all your devices?")) return;
    try {
      await logoutEverywhere();
    } catch (err) {
      setStatus("Could not sign out everywhere");
      return;
    }
    await refresh();
  });
}