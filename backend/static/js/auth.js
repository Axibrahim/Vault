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

export async function signInWithGoogle() {
  const auth = await prepareAuth();

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const result = await signInWithPopup(auth, provider);
  try {
    const idToken = await result.user.getIdToken();
    return await api("POST", "/api/auth/login", { idToken });
  } finally {
    // Our server cookie is the real session; drop Firebase's client session.
    await signOut(auth);
  }
}

export const getMe = () => api("GET", "/api/auth/me");
export const logout = () => api("POST", "/api/auth/logout");