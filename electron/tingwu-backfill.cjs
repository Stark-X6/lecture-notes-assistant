const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { TingwuASR } = require("./tingwu-asr.cjs");

function gapsFor(store, lid, start, end) {
  let gaps = [{ start, end }];
  for (const r of store.s.streams
    .filter((s) => s.lessonId === lid)
    .flatMap((s) => s.confirmed)) {
    gaps = gaps.flatMap((g) =>
      r.endMs <= g.start || r.startMs >= g.end
        ? [g]
        : [
            { start: g.start, end: Math.min(g.end, r.startMs) },
            { start: Math.max(g.start, r.endMs), end: g.end },
          ].filter((g) => g.end - g.start > 0.1),
    );
  }
  return gaps;
}
async function replayTingwu(store, lid, credentials, options) {
  let failure,
    lastEnd = null,
    count = 0;
  const factory = options.factory || ((...args) => new TingwuASR(...args));
  const asr = factory(store, lid, credentials, options.onPartial, (message) => {
    failure = new Error(message);
    options.onError(message);
  });
  const abort = () => {
    void asr.disconnect();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const chunks = store.s.chunks
    .filter((c) => c.lessonId === lid && !c.transcribed)
    .sort((a, b) => a.startMs - b.startMs);
  try {
    for (const chunk of chunks) {
      for (const gap of gapsFor(store, lid, chunk.startMs, chunk.endMs)) {
        options.signal.throwIfAborted();
        options.ensureAllowed();
        if (lastEnd === null || Math.abs(gap.start - lastEnd) > 2) {
          if (lastEnd !== null) await asr.pause();
          if (failure) throw failure;
          options.reserve();
          count++;
        }
        const wav = fs.readFileSync(chunk.path);
        if (
          wav.toString("ascii", 0, 4) !== "RIFF" ||
          wav.readUInt32LE(24) !== 24000 ||
          wav.readUInt16LE(22) !== 1
        )
          throw new Error("本地录音格式无效，无法补转写");
        let startSample = Math.round((gap.start - chunk.startMs) * 24);
        const endSample = Math.min(
          (wav.length - 44) / 2,
          Math.round((gap.end - chunk.startMs) * 24),
        );
        while (startSample < endSample) {
          options.signal.throwIfAborted();
          options.ensureAllowed();
          if (failure) throw failure;
          const next = Math.min(startSample + 2400, endSample);
          const start = chunk.startMs + startSample / 24,
            end = chunk.startMs + next / 24;
          asr.frame(
            wav.subarray(44 + startSample * 2, 44 + next * 2),
            start,
            end,
          );
          await delay(end - start, undefined, { signal: options.signal });
          startSample = next;
          lastEnd = end;
        }
      }
    }
    await asr.stop();
    options.signal.throwIfAborted();
    if (failure) throw failure;
    const unfinished = chunks.filter(
      (c) => gapsFor(store, lid, c.startMs, c.endMs).length,
    );
    store.tx(() => {
      for (const c of chunks) if (!unfinished.includes(c)) c.transcribed = true;
    });
    if (unfinished.length)
      throw new Error("部分音频未获得听悟确认，已保留，可再次补转写");
    return { count };
  } finally {
    options.signal.removeEventListener("abort", abort);
    await asr.disconnect();
  }
}
module.exports = { gapsFor, replayTingwu };
