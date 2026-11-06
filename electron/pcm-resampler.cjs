// Streaming 24 kHz PCM16LE -> 16 kHz. A windowed-sinc low-pass filter
// suppresses aliasing; history and rational phase survive frame boundaries.
class PCMResampler {
  constructor() {
    this.samples = [];
    this.offset = 0;
    this.inputCount = 0;
    this.outputCount = 0;
    this.kernels = [0, 0.5].map((phase) => {
      const weights = [];
      for (let k = -24; k <= 24; k++) {
        const x = k - phase;
        const sinc =
          x === 0 ? 0.6 : Math.sin(2 * Math.PI * 0.3 * x) / (Math.PI * x);
        weights.push(sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / 25)));
      }
      const sum = weights.reduce((a, b) => a + b, 0);
      return weights.map((w) => w / sum);
    });
  }
  push(pcm) {
    const b = Buffer.from(pcm);
    if (b.length % 2) throw new Error("PCM 必须包含完整的 16 位采样");
    for (let i = 0; i < b.length; i += 2) this.samples.push(b.readInt16LE(i));
    this.inputCount += b.length / 2;
    const out = [];
    while (this.outputCount * 1.5 < this.inputCount) {
      const t = this.outputCount * 1.5;
      const center = Math.floor(t) - 24;
      const kernel = this.kernels[this.outputCount % 2];
      let value = 0;
      for (let k = -24; k <= 24; k++) {
        const index = center + k;
        value +=
          (index < 0 ? 0 : this.samples[index - this.offset] || 0) *
          kernel[k + 24];
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(value))));
      this.outputCount++;
    }
    const drop = Math.max(0, this.samples.length - 52);
    this.samples.splice(0, drop);
    this.offset += drop;
    const result = Buffer.alloc(out.length * 2);
    out.forEach((v, i) => result.writeInt16LE(v, i * 2));
    return result;
  }
}
module.exports = { PCMResampler };
