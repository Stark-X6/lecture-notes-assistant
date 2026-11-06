class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(2400);
    this.index = 0;
    this.port.onmessage = (event) => {
      this.flush();
      this.port.postMessage({
        type: "flushed",
        requestId: event.data.requestId,
      });
    };
  }
  flush() {
    if (this.index) {
      const out = this.buffer.slice(0, this.index);
      this.port.postMessage(out.buffer, [out.buffer]);
      this.index = 0;
    }
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input)
      for (const sample of input) {
        this.buffer[this.index++] = Math.round(
          Math.max(-1, Math.min(1, sample)) * 32767,
        );
        if (this.index === 2400) this.flush();
      }
    return true;
  }
}
registerProcessor("pcm-recorder", PCMRecorder);
