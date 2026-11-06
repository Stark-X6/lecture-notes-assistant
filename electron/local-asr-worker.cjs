// Native inference is isolated from recording and the UI.
const path = require('node:path');
const sherpa = require('sherpa-onnx-node');
try {
  const dir = process.argv[2];
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: path.join(dir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
      tokens: path.join(dir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0,
    },
  });
  process.send({ type: 'ready' });
  process.on('message', (m) => {
    try {
      const started = Date.now();
      const wave = sherpa.readWave(m.file, false);
      const from = Math.max(0, Math.round((m.fromMs || 0) * wave.sampleRate / 1000));
      const to = m.toMs == null ? wave.samples.length : Math.min(wave.samples.length, Math.round(m.toMs * wave.sampleRate / 1000));
      const samples = wave.samples.subarray(from, to);
      if (!samples.length) throw new Error('音频范围为空');
      let energy = 0;
      for (const x of samples) energy += x * x;
      let text = '';
      if (Math.sqrt(energy / samples.length) > 0.0001) {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: wave.sampleRate });
        recognizer.decode(stream);
        text = recognizer.getResult(stream).text.replace(/<\|[^|]*\|>/g, '').trim();
      }
      process.send({ id: m.id, text, audioSeconds: samples.length / wave.sampleRate, elapsedMs: Date.now() - started });
    } catch (e) { process.send({ id: m.id, error: e.message }); }
  });
} catch (e) { process.send({ type: 'fatal', error: e.message }); process.exitCode = 1; }
process.on('disconnect', () => process.exit(0));
