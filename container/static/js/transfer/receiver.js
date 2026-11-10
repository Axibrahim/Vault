// Receives one file from one data channel. Every block is hashed and compared with the
// sender's hash BEFORE it is written, so a damaged block can never reach your disk.
import { MAX_CHUNK_SIZE, blockCount, blockLength, parseFileMessage } from "./protocol.js";
import { sha256Hex } from "./blocks.js";

// meta: { size }   writer: { writeBlock(index, bytes), finish() -> result, abort() }, or a promise of one
// (the channel starts delivering before the file is opened, so the writer may still be opening).
export function receiveFile(channel, { meta, writer, startBlock = 0, onBytes = () => {}, onBlock = () => {} }) {
  channel.binaryType = "arraybuffer";
  const total = blockCount(meta.size);

  return new Promise((resolve, reject) => {
    let index = startBlock;
    let block = index < total ? new Uint8Array(blockLength(meta.size, index)) : null;
    let filled = 0;
    let queue = Promise.resolve();    // verifying + writing happens strictly in order
    let failed = false;
    let done = false;

    const send = (obj) => {
      if (channel.readyState === "open") channel.send(JSON.stringify(obj));
    };
    const fail = (err) => {
      if (failed) return;
      failed = true;
      try { send({ t: "error", reason: "failed" }); } catch (e) { /* channel already gone */ }
      reject(err);
    };

    channel.addEventListener("close", () => {
      if (!failed && !done) fail(new Error("Connection closed"));
    });

    const commit = async (job) => {
      if ((await sha256Hex(job.bytes)) !== job.hash) throw new Error("A block failed its integrity check");
      await (await writer).writeBlock(job.index, job.bytes);
      onBlock(job.index);
      send({ t: "ack", i: job.index });
    };

    channel.onmessage = (event) => {
      if (failed) return;
      try {
        if (typeof event.data !== "string") {
          const bytes = new Uint8Array(event.data);
          if (!block || bytes.length === 0 || bytes.length > MAX_CHUNK_SIZE || filled + bytes.length > block.length) {
            throw new Error("Unexpected data");
          }
          block.set(bytes, filled);
          filled += bytes.length;
          onBytes(bytes.length);
          return;
        }

        const msg = parseFileMessage(event.data);

        if (msg.t === "block") {
          if (!block || msg.i !== index || filled !== block.length) throw new Error("Block out of order");
          const job = { index, bytes: block, hash: msg.h };
          index += 1;
          block = index < total ? new Uint8Array(blockLength(meta.size, index)) : null;
          filled = 0;
          queue = queue.then(() => commit(job)).catch(fail);
          return;
        }

        if (msg.t === "end") {
          if (msg.blocks !== total || index !== total) throw new Error("File ended early");
          queue = queue
            .then(async () => {
              if (failed) return;
              const result = await (await writer).finish();
              done = true;
              send({ t: "done" });
              resolve(result);
            })
            .catch(fail);
          return;
        }
        throw new Error("Unexpected message");
      } catch (err) {
        fail(err);
      }
    };
  });
}