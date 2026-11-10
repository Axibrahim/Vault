// Lets async code say "wait until this is true" and be woken when something changes.
// It rejects as soon as the channel closes or the transfer is cancelled, so nothing hangs.
export function makeWaiter(channel, signal) {
  const waiting = new Set();
  let dead = null;

  const poke = () => {
    for (const check of [...waiting]) check();
  };
  const kill = (error) => {
    dead = dead || error;
    poke();
  };

  channel.addEventListener("close", () => kill(new Error("Connection closed")));
  channel.addEventListener("error", () => kill(new Error("Connection error")));
  if (signal) {
    if (signal.aborted) dead = new Error("Cancelled");
    signal.addEventListener("abort", () => kill(new Error("Cancelled")));
  }

  return {
    poke,
    kill,
    until(condition) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (dead) {
            waiting.delete(check);
            reject(dead);
          } else if (condition()) {
            waiting.delete(check);
            resolve();
          }
        };
        waiting.add(check);
        check();
      });
    },
  };
}