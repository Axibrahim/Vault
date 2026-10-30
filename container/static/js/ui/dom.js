import { setSceneState } from "../scene/scene.js";

export const $ = (id) => document.getElementById(id);

export function setStatus(message) {
  $("status").textContent = message;
}

// Shows one screen: "login", "enroll", "desktop" or "other".
export function show(view) {
  setSceneState(view);
  $("login-view").hidden = view !== "login";
  $("app-view").hidden = view === "login";
  $("enroll-view").hidden = view !== "enroll";
  $("desktop-view").hidden = view !== "desktop";
  $("other-view").hidden = view !== "other";
}