// Install-to-home-screen support: registers the service worker and shows an install button.
// Chrome / Edge / Android fire "beforeinstallprompt"; iPhone and iPad never do,
// so they get a short hint about Share > Add to Home Screen instead.
import { $ } from "./dom.js";

let deferredPrompt = null;

const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function refresh() {
  const canPrompt = deferredPrompt !== null;
  const needsHint = !canPrompt && isIos();
  $("install-btn").hidden = !canPrompt;
  $("install-ios").hidden = !needsHint;
  $("install-box").hidden = isInstalled() || !(canPrompt || needsHint);
}

export function initPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    refresh();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    refresh();
  });

  $("install-btn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    const prompt = deferredPrompt;
    deferredPrompt = null;
    refresh();
    await prompt.prompt();
  });

  refresh();
}