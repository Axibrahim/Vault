// Decides which screen this browser should see. No DOM here, so it is easy to test.
//
//   kind    "phone" or "computer" (see device/kind.js)
//   counts  how many ACTIVE devices the account has: { desktop, phone }
//   mine    this browser's own active device record, or null if it is not enrolled
//
// Returns: "desktop" | "phone" | "pair" | "enroll" | "needComputer" | "other"

// Keep this in sync with MAX_PER_TYPE in routes/devices.py
export const MAX_PER_TYPE = 3;

export function pickScreen({ kind, counts = { desktop: 0, phone: 0 }, mine }) {
  // A browser that already holds a device key always gets its own screen.
  if (mine && mine.type === "desktop") return "desktop";
  if (mine && mine.type === "phone") return "phone";

  if (kind === "phone") {
    if (counts.desktop === 0) return "needComputer";           // a phone cannot be the computer
    if (counts.phone >= MAX_PER_TYPE) return "other";          // all phone places are taken
    return "pair";                                             // join with the code a computer shows
  }

  // A computer that is not enrolled yet.
  if (counts.desktop >= MAX_PER_TYPE) return "other";          // all computer places are taken
  return "enroll";                                             // set this computer up
}