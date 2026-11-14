// About: a settings-style panel that explains how Vault moves files and how it protects them.
// The text is fixed and lives in index.html, so nothing is loaded and it opens at once.
// Settings and About share the main card, so opening one closes the other (see "vault-panel").
import { $ } from "../ui/dom.js";

const TABS = ["how", "options", "security"];

let isOpen = false;
let tab = "how";

export const showAboutButton = (visible) => { $("about-btn").hidden = !visible; };

function moveInk() {
  const button = $(`about-tab-${tab}`);
  const ink = $("about-tab-ink");
  ink.style.setProperty("--ink-x", `${button.offsetLeft}px`);
  ink.style.setProperty("--ink-w", `${button.offsetWidth}px`);
}

function selectTab(name, { focus = false } = {}) {
  tab = name;
  for (const id of TABS) {
    const on = id === name;
    $(`about-tab-${id}`).setAttribute("aria-selected", String(on));
    $(`about-tab-${id}`).tabIndex = on ? 0 : -1;
    $(`about-tabpanel-${id}`).hidden = !on;
  }
  moveInk();
  if (focus) $(`about-tab-${name}`).focus();
}

function onTabKey(event) {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  selectTab(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length], { focus: true });
}

export function openAbout() {
  if (isOpen) return;
  // Tell Settings first: closing it clears the shared "panel" marker, so ours must be set after.
  document.dispatchEvent(new CustomEvent("vault-panel", { detail: "about" }));
  isOpen = true;
  document.body.dataset.panel = "about";
  $("about-view").hidden = false;
  $("about-btn").setAttribute("aria-expanded", "true");
  selectTab(tab);
}

export function closeAbout({ restoreFocus = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  delete document.body.dataset.panel;
  $("about-view").hidden = true;
  $("about-btn").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("about-btn").focus();
}

export function initAbout() {
  $("about-btn").addEventListener("click", () => (isOpen ? closeAbout({ restoreFocus: true }) : openAbout()));
  $("about-done").addEventListener("click", () => closeAbout({ restoreFocus: true }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen) closeAbout({ restoreFocus: true });
  });
  document.addEventListener("vault-panel", (event) => { if (event.detail !== "about") closeAbout(); });
  window.addEventListener("resize", () => { if (isOpen) moveInk(); });

  for (const id of TABS) $(`about-tab-${id}`).addEventListener("click", () => selectTab(id));
  $("about-tab-how").parentElement.addEventListener("keydown", onTabKey);
}