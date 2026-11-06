const { ipcRenderer } = require("electron");
window.addEventListener("DOMContentLoaded", () => {
  let ctx, stream, source, worklet, silent;
  ipcRenderer.on("capture:command", async (_, cmd) => {
    try {
      if (cmd.type === "start") {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 24000,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        ctx = new AudioContext({ sampleRate: 24000 });
        await ctx.audioWorklet.addModule("./pcm-worklet.js");
        source = ctx.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(ctx, "pcm-recorder");
        silent = ctx.createGain();
        silent.gain.value = 0;
        source.connect(worklet).connect(silent).connect(ctx.destination);
        worklet.port.onmessage = (e) =>
          ipcRenderer.send("capture:frame", e.data);
        stream.getAudioTracks()[0].onended = () =>
          ipcRenderer.send("capture:error", "麦克风已断开");
        await ctx.resume();
      }
      if (cmd.type === "pause") {
        await ctx.suspend();
        worklet.port.postMessage("flush");
      }
      if (cmd.type === "resume") await ctx.resume();
      if (cmd.type === "stop") {
        await ctx.suspend();
        worklet.port.postMessage("flush");
        await new Promise((r) => setTimeout(r, 80));
        stream?.getTracks().forEach((t) => t.stop());
        await ctx.close();
      }
      ipcRenderer.send("capture:ack", cmd.id);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      ipcRenderer.send("capture:error", e.message);
      ipcRenderer.send("capture:ack", cmd.id, e.message);
    }
  });
});
