// Small shared state for the single page.
export const state = {
  uid: null,          // Firebase uid of the signed-in user
  setupFolder: null,  // folder picked during setup, before the computer is enrolled
  pairing: null,      // while the computer shows a code: { pairingId, fingerprint }
  phoneId: null,      // the paired phone, if there is one
};