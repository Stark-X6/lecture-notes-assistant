const { ipcRenderer } = require("electron");
window.addEventListener("DOMContentLoaded", () => {
  let ctx, stream, source, worklet, silent;
  let pendingFlush;
  function flushWorklet(requestId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFlush = null;
        reject(new Error("音频尾帧确认超时"));
      }, 3000);
      pendingFlush = {
        requestId,
        resolve: () => {
          clearTimeout(timer);
          pendingFlush = null;
          resolve();
        },
      };
      worklet.port.postMessage({ type: "flush", requestId });
    });
  }
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
        worklet.port.onmessage = (e) => {
          if (e.data?.type === "flushed") {
            if (pendingFlush?.requestId === e.data.requestId)
              pendingFlush.resolve();
          } else ipcRenderer.send("capture:frame", e.data);
        };
        stream.getAudioTracks()[0].onended = () =>
          ipcRenderer.send("capture:error", "麦克风已断开");
        await ctx.resume();
      }
      if (cmd.type === "pause") {
        await ctx.suspend();
        await flushWorklet(cmd.id);
      }
      if (cmd.type === "resume") await ctx.resume();
      if (cmd.type === "stop") {
        await ctx.suspend();
        await flushWorklet(cmd.id);
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
