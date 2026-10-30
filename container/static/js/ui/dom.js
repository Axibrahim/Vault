import { setSceneState } from "../scene/scene.js";

export const $ = (id) => document.getElementById(id);

export function setStatus(message) {
  $("status").textContent = message;
}

// Repeating timers belong to the screen that started them.
// show() stops them all, so a screen can never leave a timer running behind it.
const timers = new Set();

export function every(milliseconds, action) {
  const id = setInterval(action, milliseconds);
  timers.add(id);
  return id;
}

export function stopTimer(id) {
  clearInterval(id);
  timers.delete(id);
}

const VIEWS = ["enroll", "desktop", "pair", "phone", "other"];

// Shows one screen: "login", "enroll", "desktop", "pair", "phone" or "other".
export function show(view) {
  for (const id of timers) clearInterval(id);
  timers.clear();

  setSceneState(view);
  $("login-view").hidden = view !== "login";
  $("app-view").hidden = view === "login";
  for (const name of VIEWS) {
    $(`${name}-view`).hidden = view !== name;
  }
}