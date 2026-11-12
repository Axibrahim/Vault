// Sends one file over one data channel: block by block, as fast as the network allows,
// and never faster than the receiver can write it to disk.
import {
  BLOCK_SIZE, CHUNK_SIZE, HIGH_WATER, LOW_WATER, WINDOW_BLOCKS,
  blockCount, parseFileMessage,
} from "./protocol.js";
import { integrityError, readBlock } from "./blocks.js";
import { makeWaiter } from "./waiter.js";

// hashes: the block hashes that were worked out when the file was scanned before the transfer.
// Every block that is read now must still hash to the same value, or the file changed under us.
export async function sendFile(channel, file, {
  startBlock = 0, hashes, onBytes = () => {}, onActivity = () => {}, signal, chunkSize = CHUNK_SIZE,
} = {}) {
  const total = blockCount(file.size);
  if (!Array.isArray(hashes) || hashes.length !== total) throw new Error("This file was not checked before sending");
  const waiter = makeWaiter(channel, signal);
  // nothing is ever sent after the transfer was cancelled, failed or ended
  const guard = () => { if (signal && signal.aborted) throw new Error("Cancelled"); };

  let acked = startBlock;          // blocks the receiver has verified AND written
  let finished = false;
  let remoteError = null;

  channel.bufferedAmountLowThreshold = LOW_WATER;
  channel.addEventListener("bufferedamountlow", waiter.poke);
  channel.onmessage = (event) => {
    onActivity();
    try {
      const msg = parseFileMessage(event.data);
      if (msg.t === "ack") acked = Math.max(acked, msg.i + 1);
      else if (msg.t === "done") finished = true;
      else if (msg.t === "error") remoteError = new Error(msg.reason === "integrity"
        ? "The other device found a damaged file and discarded it" : msg.reason || "The other device reported an error");
    } catch (err) {
      remoteError = new Error("The other device sent something unexpected");
    }
    if (remoteError) waiter.kill(remoteError);
    waiter.poke();
  };

  let next = startBlock < total ? readBlock(file, startBlock) : null;
  if (next) next.catch(() => {});                      // a failed read is reported where it is awaited

  for (let i = startBlock; i < total; i += 1) {
    // stay at most WINDOW_BLOCKS ahead of what the receiver has safely written
    await waiter.until(() => i - acked < WINDOW_BLOCKS);

    const block = await next;
    if (block.hash !== hashes[i]) throw integrityError("This file changed while it was being sent");
    next = i + 1 < total ? readBlock(file, i + 1) : null;   // read + hash the next block while this one is on the wire
    if (next) next.catch(() => {});

    for (let offset = 0; offset < block.bytes.length; offset += chunkSize) {
      await waiter.until(() => channel.bufferedAmount <= HIGH_WATER);
      guard();
      const chunk = block.bytes.subarray(offset, offset + chunkSize);
      channel.send(chunk);
      onBytes(chunk.length);
    }
    guard();
    channel.send(JSON.stringify({ t: "block", i, h: block.hash }));
  }

  guard();
  channel.send(JSON.stringify({ t: "end", blocks: total }));
  await waiter.until(() => finished);
}

export { BLOCK_SIZE };