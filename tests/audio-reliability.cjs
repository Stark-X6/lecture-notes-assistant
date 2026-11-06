// 90-minute equivalent PCM capacity test, accelerated. This deliberately does
// not claim to be a 90-minute wall-clock physical microphone test.
const { Worker } = require("node:worker_threads"),
  fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { once } = require("node:events");
(async () => {
  const root = path.resolve(".test-data", "audio-capacity-" + Date.now());
  fs.mkdirSync(root, { recursive: true });
  const workerFile = path.resolve("electron/audio-worker.cjs"),
    started = Date.now();
  const worker = new Worker(workerFile, {
    workerData: { dir: path.join(root, "audio"), startMs: 0, seq: 0 },
  });
  const chunks = [],
    errors = [];
  worker.on("message", (m) => {
    if (m.type === "chunk") chunks.push(m);
    if (m.type === "error") errors.push(m);
  });
  const frame = Buffer.alloc(4800);
  for (let chunk = 0; chunk < 1080; chunk++) {
    const next = once(worker, "message");
    for (let i = 0; i < 50; i++)
      worker.postMessage({ type: "frame", pcm: frame });
    const [message] = await next;
    assert.equal(message.type, "chunk");
  }
  worker.postMessage({ type: "stop" });
  await once(worker, "exit");
  assert.equal(chunks.length, 1080);
  assert.equal(errors.length, 0);
  assert.equal(chunks.at(-1).endMs, 5400000);
  for (let i = 0; i < chunks.length; i++) {
    assert.equal(chunks[i].startMs, i * 5000);
    const data = fs.readFileSync(chunks[i].path);
    assert.equal(data.length, 240044);
    assert.equal(data.readUInt32LE(40), 240000);
  }
  // A worker-level injected ENOSPC exercises the same error event path without
  // filling or damaging the user's disk.
  const faulty = new Worker(
    `const fs=require('node:fs');fs.writeFileSync=()=>{throw Object.assign(new Error('full'),{code:'ENOSPC'})};require(${JSON.stringify(workerFile)});`,
    {
      eval: true,
      workerData: { dir: path.join(root, "full"), startMs: 0, seq: 0 },
    },
  );
  const error = once(faulty, "message");
  faulty.postMessage({ type: "frame", pcm: Buffer.alloc(240000) });
  const [event] = await error;
  assert.equal(event.type, "error");
  assert.match(event.message, /ENOSPC/);
  await faulty.terminate();
  const { writeStalled } = require("../electron/capture-health.cjs");
  assert.equal(writeStalled(16001, 0, 10000, 5000), true);
  assert.equal(writeStalled(14000, 0, 10000, 5000), false);
  assert.equal(writeStalled(20000, 0, 4000, 0), false);
  const report = {
    mode: "accelerated synthetic PCM",
    equivalentMinutes: 90,
    chunks: chunks.length,
    audioBytes: chunks.length * 240044,
    elapsedMs: Date.now() - started,
    diskFullInjection: "pass",
    writeAckWatchdog: "pass",
    physicalMicrophone90Minutes: "not run",
  };
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync(
    "artifacts/audio-reliability.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  const resolved = fs.realpathSync(root);
  assert.ok(resolved.startsWith(path.resolve(".test-data") + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
