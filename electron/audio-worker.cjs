const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { atomicWrite } = require("./core.cjs");
let pieces = [],
  samples = 0,
  start = workerData.startMs,
  seq = workerData.seq;
function flush() {
  if (!samples) return;
  const pcm = Buffer.concat(pieces);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  const end = start + samples / 24;
  const file = path.join(
    workerData.dir,
    `${seq}-${Math.round(start)}-${Math.round(end)}.wav`,
  );
  atomicWrite(file, wav);
  parentPort.postMessage({
    type: "chunk",
    seq,
    startMs: Math.round(start),
    endMs: Math.round(end),
    path: file,
    checksum: crypto.createHash("sha256").update(wav).digest("hex"),
  });
  start = end;
  seq++;
  pieces = [];
  samples = 0;
}
parentPort.on("message", (m) => {
  try {
    if (m.type === "frame") {
      const b = Buffer.from(m.pcm);
      pieces.push(b);
      samples += b.length / 2;
      if (samples >= 120000) flush();
    } else if (m.type === "flush") {
      flush();
      parentPort.postMessage({ type: "flushed", requestId: m.requestId });
    } else if (m.type === "stop") {
      flush();
      parentPort.postMessage({ type: "stopped" });
      parentPort.close();
    }
  } catch (e) {
    parentPort.postMessage({
      type: "error",
      message: "音频写盘失败：" + e.code,
    });
  }
});
