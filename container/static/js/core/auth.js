import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  setPersistence,
  inMemoryPersistence,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import { api } from "./api.js";

let firebaseAuth = null;

// "Keep me signed in" is only a preference (true/false), never a secret.
const REMEMBER_KEY = "vault:remember";

export function getRememberPreference() {
  try {
    return localStorage.getItem(REMEMBER_KEY) === "1";
  } catch (err) {
    return false;
  }
}

export function setRememberPreference(value) {
  try {
    localStorage.setItem(REMEMBER_KEY, value ? "1" : "0");
  } catch (err) {
    // storage blocked: the choice simply won't be remembered
  }
}

// Loads the public Firebase settings from our server and prepares the SDK.
// Called early so the sign-in popup can open instantly on click.
export async function prepareAuth() {
  if (firebaseAuth) return firebaseAuth;

  const config = await api("GET", "/api/auth/config");
  const app = initializeApp(config);
  const auth = getAuth(app);

  // Keep Firebase's own tokens in memory only, never in localStorage/IndexedDB.
  await setPersistence(auth, inMemoryPersistence);

  firebaseAuth = auth;
  return auth;
}

export async function signInWithGoogle(remember = false) {
  const auth = await prepareAuth();

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const result = await signInWithPopup(auth, provider);
  try {
    const idToken = await result.user.getIdToken();
    return await api("POST", "/api/auth/login", { idToken, remember });
  } finally {
    // Our server cookie is the real session; drop Firebase's client session.
    await signOut(auth);
  }
}

// Runs a sensitive action. If the server says "sign in again", the user
// confirms with Google once more and the action is retried a single time.
export async function withReauth(action) {
  try {
    return await action();
  } catch (err) {
    if (err.code !== "reauth_required") throw err;
    await signInWithGoogle(getRememberPreference());
    return await action();
  }
}

export const getMe = () => api("GET", "/api/auth/me");
export const logout = () => api("POST", "/api/auth/logout");
export const logoutEverywhere = () => api("POST", "/api/auth/logout-all");