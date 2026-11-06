// Inference is isolated from recording and the UI; audio never leaves the machine.
const path = require("node:path");
const sherpa = require("sherpa-onnx-node");
const { review } = require("./local-asr-quality.cjs");
const dir = process.argv[2],
  modelId = process.argv[3] || "sensevoice";
let recognizer, previousTerms;
function load(hotwords = "") {
  if (recognizer && previousTerms === hotwords) return;
  recognizer = null;
  const modelConfig = { numThreads: 4, provider: "cpu", debug: 0 };
  if (modelId === "qwen3")
    modelConfig.qwen3Asr = {
      convFrontend: path.join(dir, "model_0.6B/conv_frontend.onnx"),
      encoder: path.join(dir, "model_0.6B/encoder.int8.onnx"),
      decoder: path.join(dir, "model_0.6B/decoder.int8.onnx"),
      tokenizer: path.join(dir, "tokenizer"),
      hotwords,
      maxTotalLen: 512,
      maxNewTokens: 256,
      temperature: 0.000001,
      topP: 0.8,
      seed: 42,
    };
  else {
    modelConfig.senseVoice = {
      model: path.join(dir, "model.int8.onnx"),
      language: "zh",
      useInverseTextNormalization: 1,
    };
    modelConfig.tokens = path.join(dir, "tokens.txt");
  }
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig,
  });
  previousTerms = hotwords;
}
function read(segments) {
  let rate;
  const parts = segments.map((m) => {
    const w = sherpa.readWave(m.file, false);
    if (rate && w.sampleRate !== rate) throw Error("录音采样率不一致");
    rate = w.sampleRate;
    const from = Math.max(0, Math.round(((m.fromMs || 0) * rate) / 1000)),
      to =
        m.toMs == null
          ? w.samples.length
          : Math.min(w.samples.length, Math.round((m.toMs * rate) / 1000));
    return w.samples.subarray(from, to);
  });
  const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    samples.set(p, at);
    at += p.length;
  }
  return { samples, sampleRate: rate };
}
// Prefer a quiet boundary in the last 8 seconds, without guessing word timestamps.
function boundary(samples, rate) {
  const duration = samples.length / rate;
  if (duration < 19.8) return samples.length;
  const width = Math.round(rate * 0.15),
    start = Math.round(rate * 12);
  let best = null,
    total = 0;
  for (const x of samples) total += x * x;
  const threshold = Math.sqrt(total / samples.length) * 0.25;
  for (
    let i = start;
    i + width < samples.length;
    i += Math.round(rate * 0.05)
  ) {
    let e = 0;
    for (let j = i; j < i + width; j++) e += samples[j] * samples[j];
    const rms = Math.sqrt(e / width);
    if (rms < threshold && rms < 0.015) best = i + width;
  }
  return best || samples.length;
}
try {
  // Qwen is loaded on the first request so its course terms are included once.
  if (modelId !== "qwen3") load();
  process.send({ type: "ready" });
  process.on("message", (m) => {
    try {
      const started = Date.now();
      load(modelId === "qwen3" ? m.hotwords || "" : "");
      const wave = read(m.segments);
      const end = m.preferPause
        ? boundary(wave.samples, wave.sampleRate)
        : wave.samples.length;
      const samples = wave.samples.subarray(0, end);
      if (!samples.length) throw Error("音频范围为空");
      let energy = 0;
      for (const x of samples) energy += x * x;
      let text = "";
      if (Math.sqrt(energy / samples.length) > 0.0001) {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: wave.sampleRate });
        recognizer.decode(stream);
        text = recognizer
          .getResult(stream)
          .text.replace(/<\|[^|]*\|>/g, "")
          .trim();
      }
      if (!/[\p{L}\p{N}]/u.test(text)) text = "";
      process.send({
        id: m.id,
        text,
        ...review(text, m.hotwords),
        audioSeconds: samples.length / wave.sampleRate,
        consumedMs: Math.round((samples.length / wave.sampleRate) * 1000),
        elapsedMs: Date.now() - started,
      });
    } catch (e) {
      process.send({ id: m.id, error: e.message });
    }
  });
} catch (e) {
  process.send({ type: "fatal", error: e.message });
  process.exitCode = 1;
}
process.on("disconnect", () => process.exit(0));
