// Tells a phone or tablet from a computer.
// This only chooses which screen to show. It is NOT a security check:
// the server never trusts it, and every device still proves itself with its key.
export function detectDeviceKind(env = globalThis) {
  const nav = env.navigator || {};

  // Chromium: "mobile" is a plain true/false flag.
  if (nav.userAgentData && nav.userAgentData.mobile === true) return "phone";

  const ua = nav.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "phone";

  // iPadOS pretends to be a Mac. A "Mac" with a touch screen is an iPad.
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1) return "phone";

  // "Request desktop site" on a phone: the user agent lies, but the main input is still a finger.
  if (env.matchMedia && env.matchMedia("(pointer: coarse) and (hover: none)").matches) return "phone";

  return "computer";
}