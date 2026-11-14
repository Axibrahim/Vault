// Receives one file from one data channel. Every block is hashed and compared with the
// sender's hash BEFORE it is written, so a damaged block can never reach your disk. When the
// last block is in, the digest of the whole file must match the one promised in the file list,
// and the saved file is read back from disk and checked again before the file counts as received.
import { MAX_CHUNK_SIZE, blockCount, blockLength, parseFileMessage } from "./protocol.js";
import { integrityError, sha256Hex, treeDigest } from "./blocks.js";

const VERIFY_BEAT_MS = 1000;

// meta: { size, digest }
// writer: { writeBlock(index, bytes), finish(hashes) -> result, abort() }, or a promise of one
//   (the channel starts delivering before the file is opened, so the writer may still be opening).
// hashes: the verified block hashes so far. It is filled in as blocks are saved, and it is what lets
//   a resumed transfer carry on from the right block.
// active(): false once this transfer must not accept anything any more (cancelled, failed, over).
export function receiveFile(channel, {
  meta, writer, hashes = [], onBytes = () => {}, onBlock = () => {}, onActivity = () => {}, active = () => true,
}) {
  channel.binaryType = "arraybuffer";
  const total = blockCount(meta.size);

  return new Promise((resolve, reject) => {
    let index = hashes.length;
    let block = index < total ? new Uint8Array(blockLength(meta.size, index)) : null;
    let filled = 0;
    let queue = Promise.resolve();    // verifying + writing happens strictly in order
    let failed = false;
    let done = false;

    const send = (obj) => {
      if (channel.readyState === "open") channel.send(JSON.stringify(obj));
    };
    const fail = (err) => {
      if (failed || done) return;
      failed = true;
      try { send({ t: "error", reason: err.integrity ? "integrity" : "failed" }); } catch (e) { /* channel already gone */ }
      reject(err);
    };

    channel.addEventListener("close", () => {
      if (!failed && !done) fail(new Error("Connection closed"));
    });

    const commit = async (job) => {
      if (!active()) throw new Error("The transfer is over");
      if ((await sha256Hex(job.bytes)) !== job.hash) throw integrityError("A block failed its integrity check");
      if (!active()) throw new Error("The transfer is over");
      await (await writer).writeBlock(job.index, job.bytes, job.hash);
      hashes[job.index] = job.hash;
      onBlock(job.index);
      send({ t: "ack", i: job.index });
    };

    const finish = async () => {
      if (failed) return;
      // 1) the blocks we checked add up to the file we were promised
      if (hashes.length !== total || (await treeDigest(hashes)) !== meta.digest) {
        throw integrityError("The file does not match its expected hash");
      }
      // 2) the file that ended up on disk is made of exactly those blocks
      let beat = 0;
      const beats = setInterval(() => send({ t: "verify", i: beat++ }), VERIFY_BEAT_MS);
      try {
        const result = await (await writer).finish(hashes);
        if (failed) return;
        done = true;
        send({ t: "done" });                       // only now: after every check passed
        resolve(result);
      } finally {
        clearInterval(beats);
      }
    };

    channel.onmessage = (event) => {
      if (failed || done) return;                  // late data after the end is never accepted
      if (!active()) {
        failed = true;                             // the transfer is over: drop everything, tell nobody
        reject(new Error("The transfer is over"));
        return;
      }
      onActivity();
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
          queue = queue.then(finish).catch(fail);
          return;
        }
        throw new Error("Unexpected message");
      } catch (err) {
        fail(err);
      }
    };

    // A file with nothing in it has no blocks: the sender's "end" is all there is to check.
  });
}