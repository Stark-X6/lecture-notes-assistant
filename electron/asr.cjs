const WebSocket = require("ws");
const { id, check, normalizeTime } = require("./core.cjs");
const { endpoint } = require("./provider.cjs");
class LiveASR {
  constructor(store, lid, key, onPartial, onError, Socket = WebSocket) {
    this.store = store;
    this.lid = lid;
    this.key = key;
    this.Socket = Socket;
    this.onPartial = onPartial;
    this.onError = onError;
    this.socket = null;
    this.ready = false;
    this.pending = [];
    this.backlog = [];
    this.items = new Map();
    this.partials = new Map();
    this.nextConnect = 0;
    this.closed = false;
    this.turnStart = null;
    this.lastEnd = 0;
    this.silence = 0;
  }
  allowed() {
    const l = this.store.lesson(this.lid),
      c = this.store.course(l.courseId);
    return (
      this.store.s.config.asrBackend !== "local" &&
      !l.aiPaused &&
      this.store.s.config.mode === "http" &&
      c.consent.audio &&
      c.consent.version === this.store.s.config.version &&
      this.key
    );
  }
  connect(originMs) {
    if (
      this.closed ||
      !this.allowed() ||
      this.socket ||
      Date.now() < this.nextConnect
    )
      return;
    const cfg = this.store.s.config;
    const stream = {
      id: id(),
      lessonId: this.lid,
      originMs,
      confirmed: [],
      createdAt: Date.now(),
      timing: "chunk-range",
      providerVersion: cfg.version,
    };
    this.stream = stream;
    this.store.tx((s) => s.streams.push(stream));
    try {
      const ws = new this.Socket(endpoint(cfg.asrUrl, "wss:"), {
        headers: { Authorization: `Bearer ${this.key}` },
        handshakeTimeout: 10000,
        followRedirects: false,
      });
      this.socket = ws;
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "transcription",
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: 24000 },
                  transcription: { model: cfg.asrModel },
                  turn_detection: null,
                },
              },
            },
          }),
        );
      });
      ws.on("message", (raw) => {
        try {
          const e = JSON.parse(raw.toString());
          if (
            this.socket !== ws ||
            !this.allowed() ||
            stream.providerVersion !== this.store.s.config.version
          )
            return;
          if (e.type === "session.updated") {
            this.ready = true;
            const queued = this.backlog.splice(0);
            for (const f of queued) this.frame(f.pcm, f.start, f.end);
            return;
          }
          if (e.type === "input_audio_buffer.committed") {
            const range = this.pending.shift();
            if (range) this.items.set(e.item_id, range);
          }
          if (e.type === "conversation.item.input_audio_transcription.delta") {
            const partial =
              (this.partials.get(e.item_id) || "") + (e.delta || "");
            this.partials.set(e.item_id, partial);
            this.onPartial(partial);
          }
          if (
            e.type === "conversation.item.input_audio_transcription.completed"
          ) {
            const r = this.items.get(e.item_id);
            if (!r) return;
            this.items.delete(e.item_id);
            this.partials.delete(e.item_id);
            const time = normalizeTime(
              stream,
              r.start - stream.originMs,
              r.end - stream.originMs,
            );
            if (
              !stream.confirmed.some(
                (x) => x.startMs === time.startMs && x.endMs === time.endMs,
              )
            ) {
              this.store.tx((s) => {
                stream.confirmed.push(time);
                if (e.transcript?.trim())
                  s.utterances.push({
                    id: id(),
                    lessonId: this.lid,
                    text: e.transcript,
                    revision: 1,
                    history: [],
                    ...time,
                    timing: "chunk-range",
                    streamId: stream.id,
                    final: true,
                    topicId: null,
                    createdAt: Date.now(),
                  });
              });
            }
            this.onPartial("");
          }
          if (
            e.type === "error" ||
            e.type === "conversation.item.input_audio_transcription.failed"
          ) {
            this.onError("实时转录失败，音频继续保存；可补转写。");
            this.disconnect();
          }
        } catch {
          this.onError("实时转录事件无效，音频已保留。");
        }
      });
      ws.on("error", () =>
        this.onError("语音服务连接失败；录音继续保存，可稍后补转写。"),
      );
      ws.on("close", () => {
        if (this.socket !== ws) return;
        this.socket = null;
        this.ready = false;
        this.pending = [];
        this.backlog = [];
        this.items.clear();
        this.turnStart = null;
        this.nextConnect = Date.now() + 3000;
      });
    } catch (e) {
      this.onError(e.message);
      this.nextConnect = Date.now() + 3000;
    }
  }
  frame(pcm, start, end) {
    if (!this.allowed()) {
      this.disconnect();
      return;
    }
    this.connect(start);
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) {
      if (this.socket) {
        this.backlog.push({ pcm: Buffer.from(pcm), start, end });
        if (this.backlog.length > 30) this.backlog.shift();
      }
      return;
    }
    if (this.socket.bufferedAmount > 240000) {
      this.onError("语音连接拥塞，已转为本地保存，请补转写。");
      this.disconnect();
      return;
    }
    if (this.turnStart === null) this.turnStart = start;
    this.lastEnd = end;
    this.socket.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.from(pcm).toString("base64"),
      }),
    );
    const b = Buffer.from(pcm);
    let energy = 0;
    for (let i = 0; i < b.length; i += 2) energy += Math.abs(b.readInt16LE(i));
    this.silence =
      energy / (b.length / 2) < 350 ? this.silence + (end - start) : 0;
    if (
      (this.silence >= 500 && end - this.turnStart >= 500) ||
      end - this.turnStart >= 2000
    )
      this.commit();
  }
  commit() {
    if (this.turnStart === null || !this.ready) return;
    if (this.lastEnd - this.turnStart < 100) return;
    this.pending.push({ start: this.turnStart, end: this.lastEnd });
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.turnStart = null;
    this.silence = 0;
  }
  disconnect() {
    this.ready = false;
    this.socket?.close();
    this.socket = null;
    this.turnStart = null;
    this.pending = [];
    this.backlog = [];
    this.items.clear();
    this.partials.clear();
  }
  async stop() {
    this.closed = true;
    this.commit();
    const end = Date.now() + 5000;
    while (
      this.socket &&
      (this.pending.length || this.items.size || this.backlog.length) &&
      Date.now() < end
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const pending =
      this.pending.length || this.items.size || this.backlog.length;
    this.disconnect();
    check(!pending, "实时转录收尾超时，请补转写缺失音频");
  }
}
module.exports = { LiveASR };
