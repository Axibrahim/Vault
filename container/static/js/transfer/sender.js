// Sends one file over one data channel: block by block, as fast as the network allows,
// and never faster than the receiver can write it to disk.
import {
  BLOCK_SIZE, CHUNK_SIZE, HIGH_WATER, LOW_WATER, WINDOW_BLOCKS,
  blockCount, parseFileMessage,
} from "./protocol.js";
import { readBlock } from "./blocks.js";
import { makeWaiter } from "./waiter.js";

export async function sendFile(channel, file, { startBlock = 0, onBytes = () => {}, signal, chunkSize = CHUNK_SIZE } = {}) {
  const total = blockCount(file.size);
  const waiter = makeWaiter(channel, signal);

  let acked = startBlock;          // blocks the receiver has verified AND written
  let finished = false;
  let remoteError = null;

  channel.bufferedAmountLowThreshold = LOW_WATER;
  channel.addEventListener("bufferedamountlow", waiter.poke);
  channel.onmessage = (event) => {
    try {
      const msg = parseFileMessage(event.data);
      if (msg.t === "ack") acked = Math.max(acked, msg.i + 1);
      else if (msg.t === "done") finished = true;
      else if (msg.t === "error") remoteError = new Error(msg.reason || "The other device reported an error");
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
    next = i + 1 < total ? readBlock(file, i + 1) : null;   // read + hash the next block while this one is on the wire
    if (next) next.catch(() => {});

    for (let offset = 0; offset < block.bytes.length; offset += chunkSize) {
      await waiter.until(() => channel.bufferedAmount <= HIGH_WATER);
      const chunk = block.bytes.subarray(offset, offset + chunkSize);
      channel.send(chunk);
      onBytes(chunk.length);
    }
    channel.send(JSON.stringify({ t: "block", i, h: block.hash }));
  }

  channel.send(JSON.stringify({ t: "end", blocks: total }));
  await waiter.until(() => finished);
}

export { BLOCK_SIZE };