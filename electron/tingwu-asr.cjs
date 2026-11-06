const WebSocket = require("ws");
const { id } = require("./core.cjs");
const { TingwuAPI, meetingUrl } = require("./tingwu-api.cjs");
const { PCMResampler } = require("./pcm-resampler.cjs");

class TingwuASR {
  constructor(store, lid, credentials, onPartial, onError, options = {}) {
    Object.assign(this, { store, lid, credentials, onPartial, onError });
    this.Socket = options.Socket || WebSocket;
    this.api = options.api || new TingwuAPI(credentials);
    this.timeoutMs = options.timeoutMs || 15000;
    this.session = null;
    this.sessions = new Set();
    this.closed = false;
    this.nextConnect = 0;
  }
  allowed(version = this.store.s.config.version) {
    try {
      const l = this.store.lesson(this.lid),
        c = this.store.course(l.courseId);
      return (
        !l.aiPaused &&
        // A provider selection alone never bypasses the explicit backend
        // switch. Keep this guard for users switching back to local ASR while
        // a connection or task is still winding down.
        this.store.s.config.asrBackend !== "local" &&
        this.store.s.config.mode === "http" &&
        this.store.s.config.asrProvider === "tingwu" &&
        c.consent.audio &&
        c.consent.version === version &&
        version === this.store.s.config.version
      );
    } catch {
      return false;
    }
  }
  start(originMs) {
    const cfg = { ...this.store.s.config };
    const stream = {
      id: id(),
      lessonId: this.lid,
      originMs,
      confirmed: [],
      createdAt: Date.now(),
      timing: "provider",
      provider: "tingwu",
      providerVersion: cfg.version,
      tingwuAppKey: cfg.tingwuAppKey,
      cloudState: "creating",
    };
    this.store.tx((s) => s.streams.push(stream));
    const s = {
      stream,
      queue: [],
      resampler: new PCMResampler(),
      seen: new Set(),
      begins: new Map(),
      sentEnd: originMs,
      coveredEnd: originMs,
      ready: false,
      accepting: true,
      aborted: false,
      stopSent: false,
      completed: false,
    };
    s.done = new Promise((resolve) => {
      s.resolve = resolve;
    });
    this.session = s;
    this.sessions.add(s);
    s.timer = setTimeout(
      () => this.fail(s, "听悟连接或推流超时，音频已保存在本机"),
      this.timeoutMs,
    );
    s.initializing = this.open(s, cfg);
    return s;
  }
  async open(s, cfg) {
    try {
      const data = await this.api.create(cfg, `${this.lid}-${s.stream.id}`);
      if (!data?.taskId) throw new Error("听悟未返回任务标识");
      // Persist task identity before opening the socket, including late create responses.
      this.store.tx(() => {
        s.stream.cloudTaskId = data.taskId;
        s.stream.cloudState = "active";
      });
      if (s.aborted || !this.allowed(cfg.version)) {
        s.aborted = true;
        return;
      }
      const ws = new this.Socket(meetingUrl(data.meetingJoinUrl), {
        handshakeTimeout: 10000,
        followRedirects: false,
        maxPayload: 2 * 1024 * 1024,
      });
      s.socket = ws;
      ws.on("open", () => {
        if (s.aborted || !this.allowed(cfg.version))
          return this.fail(s, "听悟连接已取消");
        this.directive(s, "StartTranscription", {
          format: "pcm",
          sample_rate: 16000,
        });
      });
      ws.on("message", (raw) => {
        if (s.aborted || !this.allowed(cfg.version)) return;
        try {
          this.event(s, JSON.parse(raw.toString()));
        } catch {
          this.fail(s, "听悟返回无效事件，音频已保留");
        }
      });
      ws.on("error", () =>
        this.fail(s, "听悟语音连接失败，音频继续保存在本机"),
      );
      ws.on("close", () => {
        if (!s.completed && !s.aborted)
          this.fail(s, "听悟连接中断，未确认音频已保留");
      });
    } catch (error) {
      this.fail(
        s,
        error.message?.startsWith("听悟")
          ? error.message
          : "听悟任务创建失败，请检查配置和网络",
      );
    } finally {
      if (s.aborted) await this.cleanup(s);
    }
  }
  directive(s, name, payload) {
    s.socket.send(
      JSON.stringify({
        header: { namespace: "SpeechTranscriber", name },
        ...(payload ? { payload } : {}),
      }),
    );
  }
  frame(pcm, start, end) {
    if (this.closed || this.disconnecting || !this.allowed()) return;
    let s = this.session;
    if (s && s.lastQueuedEnd != null && Math.abs(start - s.lastQueuedEnd) > 2) {
      this.finish(s, false);
      s = null;
    }
    if (!s || !s.accepting) {
      if (Date.now() < this.nextConnect) return;
      if (this.sessions.size >= 2) {
        if (!this.capacityWarned)
          this.onError("听悟正在收尾前一段，后续音频已在本机保留");
        this.capacityWarned = true;
        return;
      }
      s = this.start(start);
    }
    s.queue.push({ pcm: Buffer.from(pcm), start, end });
    s.lastQueuedEnd = end;
    if (s.queue.reduce((ms, f) => ms + f.end - f.start, 0) > 5000) {
      this.fail(s, "听悟连接积压超过五秒，未确认音频已保留");
      return;
    }
    this.pump(s);
  }
  pump(s) {
    if (s.aborted || !s.ready || s.pumpTimer || s.stopSent) return;
    if (!this.allowed(s.stream.providerVersion))
      return this.fail(s, "听悟音频授权已失效");
    if (!s.queue.length) {
      if (!s.accepting) this.sendStop(s);
      return;
    }
    if (
      s.socket.readyState !== WebSocket.OPEN ||
      s.socket.bufferedAmount > 160000
    )
      return this.fail(s, "听悟推流拥塞，未确认音频已保留");
    const f = s.queue.shift();
    try {
      s.socket.send(s.resampler.push(f.pcm));
      s.sentEnd = f.end;
    } catch {
      return this.fail(s, "听悟音频发送失败，音频已保留");
    }
    // A backlog must also be paced at audio speed rather than sent in a burst.
    s.pumpTimer = setTimeout(
      () => {
        s.pumpTimer = null;
        this.pump(s);
      },
      Math.max(1, f.end - f.start),
    );
  }
  cover(s, end) {
    end = Math.min(s.sentEnd, Math.max(s.coveredEnd, end));
    if (end <= s.coveredEnd) return;
    s.stream.confirmed.push({ startMs: s.coveredEnd, endMs: end });
    s.coveredEnd = end;
  }
  event(s, e) {
    const h = e.header || {},
      p = e.payload || {};
    if (
      h.name === "TaskFailed" ||
      (h.status != null && h.status !== 20000000)
    ) {
      const code = String(h.status || "UNKNOWN")
        .replace(/[^0-9A-Z_]/g, "")
        .slice(0, 32);
      return this.fail(s, `听悟转写失败 (${code})，音频已保留`);
    }
    if (h.name === "TranscriptionStarted") {
      clearTimeout(s.timer);
      s.ready = true;
      s.streamTaskId = h.task_id;
      this.pump(s);
    }
    if (h.name === "SentenceBegin" && Number.isFinite(p.time))
      s.begins.set(p.index, p.time);
    if (h.name === "TranscriptionResultChanged")
      this.onPartial(String(p.result || ""));
    if (h.name === "SentenceEnd") {
      if (
        !Number.isInteger(p.index) ||
        !Number.isFinite(p.time) ||
        typeof p.result !== "string"
      )
        throw new Error("Invalid sentence");
      const eventKey = `${h.task_id || s.streamTaskId}:${p.index}`;
      if (s.seen.has(eventKey)) return;
      const words = Array.isArray(p.words) ? p.words : [];
      const begin =
        p.begin_time ?? words[0]?.startTime ?? s.begins.get(p.index);
      // `time` may include stash_result. Never confirm the next unfinished sentence.
      let end = p.time;
      if (p.stash_result) {
        const stashBegin = p.stash_result.beginTime;
        const wordEnd = words.at(-1)?.endTime;
        end = Number.isFinite(wordEnd)
          ? wordEnd
          : Number.isFinite(stashBegin)
            ? stashBegin
            : s.coveredEnd - s.stream.originMs;
      }
      end = Math.max(0, Math.min(end, s.sentEnd - s.stream.originMs));
      const startMs =
        s.stream.originMs +
        (Number.isFinite(begin)
          ? Math.max(0, Math.min(begin, end))
          : s.coveredEnd - s.stream.originMs);
      const endMs = s.stream.originMs + end;
      this.store.tx((state) => {
        if (p.result.trim())
          state.utterances.push({
            id: id(),
            lessonId: this.lid,
            text: p.result,
            revision: 1,
            history: [],
            startMs: Math.min(startMs, endMs),
            endMs,
            timing: Number.isFinite(begin) ? "provider" : "chunk-range",
            streamId: s.stream.id,
            providerSentenceId: eventKey,
            final: true,
            topicId: null,
            createdAt: Date.now(),
          });
        this.cover(s, endMs);
      });
      s.seen.add(eventKey);
      this.onPartial(String(p.stash_result?.text || ""));
    }
    if (h.name === "TranscriptionCompleted" && s.stopSent) {
      this.store.tx(() => this.cover(s, s.sentEnd));
      s.completed = true;
      s.ready = false;
      clearTimeout(s.timer);
      s.socket.close();
      this.onPartial("");
      void this.cleanup(s);
    }
  }
  sendStop(s) {
    if (s.stopSent || s.aborted) return;
    s.stopSent = true;
    try {
      this.directive(s, "StopTranscription", {});
    } catch {
      return this.fail(s, "听悟推流收尾失败，音频已保留");
    }
    clearTimeout(s.timer);
    s.timer = setTimeout(
      () => this.fail(s, "听悟未确认尾句，音频已保留"),
      this.timeoutMs,
    );
  }
  fail(s, message) {
    if (s.aborted || s.completed) return;
    this.nextConnect = Date.now() + 10000;
    this.onError(message);
    this.finish(s, false);
  }
  finish(s, graceful) {
    if (s.finishing) {
      if (!graceful && !s.aborted) {
        s.aborted = true;
        clearTimeout(s.pumpTimer);
        s.socket?.terminate();
        void Promise.resolve(s.initializing).then(() => this.cleanup(s));
      }
      return s.done;
    }
    s.finishing = true;
    s.accepting = false;
    if (this.session === s) this.session = null;
    if (!graceful) {
      s.aborted = true;
      s.queue = [];
      clearTimeout(s.timer);
      clearTimeout(s.pumpTimer);
      s.socket?.terminate();
      // open() handles cleanup of a task whose create response is still in flight.
      void Promise.resolve(s.initializing).then(() => this.cleanup(s));
    } else {
      this.pump(s);
    }
    return s.done;
  }
  async cleanup(s) {
    if (s.cleaning) return s.cleaning;
    s.cleaning = (async () => {
      clearTimeout(s.timer);
      clearTimeout(s.pumpTimer);
      try {
        if (s.stream.cloudTaskId) {
          this.store.tx(() => {
            s.stream.cloudState = "stopping";
          });
          await this.api.stop(s.stream.cloudTaskId);
          this.store.tx(() => {
            s.stream.cloudState = "stopped";
          });
        } else {
          this.store.tx(() => {
            s.stream.cloudState = "failed";
          });
        }
      } catch {
        this.store.tx(() => {
          s.stream.cloudState = "stop-pending";
        });
        this.onError("听悟任务尚未确认结束，请在 API 设置中重试结束云端任务");
      } finally {
        this.sessions.delete(s);
        this.capacityWarned = false;
        s.resolve();
      }
    })();
    return s.cleaning;
  }
  // A user submission closes this stream so its silent/tail range is acknowledged.
  commit() {
    if (this.session) void this.finish(this.session, true);
  }
  async pause() {
    await Promise.all([...this.sessions].map((s) => this.finish(s, true)));
  }
  async disconnect() {
    this.disconnecting = true;
    try {
      await Promise.all([...this.sessions].map((s) => this.finish(s, false)));
      this.onPartial("");
    } finally {
      this.disconnecting = false;
    }
  }
  async stop() {
    this.closed = true;
    await this.pause();
  }
}
module.exports = { TingwuASR };
