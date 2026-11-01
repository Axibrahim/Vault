// Decides which screen this browser should see. No DOM here, so it is easy to test.
//
//   kind         "phone" or "computer" (see device/kind.js)
//   accountState "no_devices" | "desktop_enrolled" | "phone_paired" (from the server)
//   mine         this browser's own active device record, or null if it is not enrolled
//
// Returns: "desktop" | "phone" | "pair" | "enroll" | "needComputer" | "other"
export function pickScreen({ kind, accountState, mine }) {
  // A browser that already holds a device key always gets its own screen.
  if (mine && mine.type === "desktop") return "desktop";
  if (mine && mine.type === "phone") return "phone";

  if (kind === "phone") {
    if (accountState === "desktop_enrolled") return "pair";        // join with the code the computer shows
    if (accountState === "no_devices") return "needComputer";      // a phone cannot be the computer
    return "other";                                                // another phone is already paired
  }

  // A computer that is not enrolled.
  if (accountState === "no_devices") return "enroll";              // set this computer up
  return "other";                                                  // set up elsewhere, or this browser was cleared
}