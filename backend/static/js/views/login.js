import { signInWithGoogle, logout } from "../core/auth.js";
import { $, setStatus } from "../ui/dom.js";

// refresh() re-checks the session and shows the right screen.
export function initLogin(refresh) {
  $("login-btn").addEventListener("click", async () => {
    setStatus("Signing in...");
    try {
      await signInWithGoogle();
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
}