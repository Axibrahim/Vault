import { prepareAuth, signInWithGoogle, getMe, logout } from "./auth.js";

const $ = (id) => document.getElementById(id);

function show(view) {
  $("login-view").hidden = view !== "login";
  $("app-view").hidden = view !== "app";
}

function setStatus(message) {
  $("status").textContent = message;
}

async function start() {
  try {
    const me = await getMe();
    $("user-email").textContent = me.email;
    setStatus("");
    show("app");
  } catch (err) {
    if (err.status === 401) {
      setStatus("Please sign in");
      show("login");
      prepareAuth().catch(() => setStatus("Could not load sign-in"));
    } else {
      setStatus("Server unreachable");
    }
  }
}

$("login-btn").addEventListener("click", async () => {
  setStatus("Signing in...");
  try {
    await signInWithGoogle();
    await start();
  } catch (err) {
    console.error("login error:", err.code || err.status, err.message);
    setStatus("Sign-in failed");
  }
});

$("logout-btn").addEventListener("click", async () => {
  try {
    await logout();
  } finally {
    await start();
  }
});

start();