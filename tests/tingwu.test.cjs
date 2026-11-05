const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  setTimeout: delay,
  setImmediate: tick,
} = require("node:timers/promises");
const { TingwuAPI, meetingUrl } = require("../electron/tingwu-api.cjs");
const { TingwuASR } = require("../electron/tingwu-asr.cjs");
const { PCMResampler } = require("../electron/pcm-resampler.cjs");
const { gapsFor, replayTingwu } = require("../electron/tingwu-backfill.cjs");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const URL = "wss://tingwu-realtime-cn-beijing.aliyuncs.com/api/ws/v1?mc=test";

class Socket extends EventEmitter {
  constructor(url, options) {
    super();
    Object.assign(this, {
      url,
      options,
      sent: [],
      readyState: 1,
      bufferedAmount: 0,
    });
    Socket.all.push(this);
  }
  send(data) {
    if (Buffer.isBuffer(data)) {
      this.sent.push(Buffer.from(data));
      return;
    }
    const e = JSON.parse(data);
    this.sent.push(e);
    if (e.header.name === "StopTranscription" && !this.suppressComplete)
      queueMicrotask(() => this.event("TranscriptionCompleted"));
  }
  event(name, payload = {}, header = {}) {
    this.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          header: { name, status: 20000000, task_id: "push-id", ...header },
          payload,
        }),
      ),
    );
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.close();
  }
}
Socket.all = [];
function fixture(options = {}) {
  const state = {
    config: {
      mode: "http",
      version: 1,
      asrProvider: "tingwu",
      tingwuAppKey: "project",
      tingwuLanguage: "cn",
    },
    streams: [],
    utterances: [],
    chunks: [],
  };
  const l = { courseId: "c", aiPaused: false },
    c = { consent: { audio: true, version: 1 } };
  const store = {
    s: state,
    lesson: () => l,
    course: () => c,
    tx: (fn) => fn(state),
  };
  const calls = [],
    partials = [],
    warnings = [];
  const api = {
    create: async () => ({
      taskId: `cloud-${state.streams.length}`,
      meetingJoinUrl: URL,
    }),
    stop: async (id) => {
      calls.push(id);
    },
    ...options.api,
  };
  const asr = new TingwuASR(
    store,
    "l",
    {},
    (p) => partials.push(p),
    (e) => warnings.push(e),
    { api, Socket, timeoutMs: 500, ...options, api },
  );
  const frame = Buffer.alloc(4800);
  for (let n = 0; n < 2400; n++)
    frame.writeInt16LE(
      Math.round(5000 * Math.sin((2 * Math.PI * 1000 * n) / 24000)),
      n * 2,
    );
  return { asr, store, state, l, c, api, calls, partials, warnings, frame };
}
async function connect(f, origin = 0) {
  f.asr.frame(f.frame, origin, origin + 100);
  await tick();
  const ws = Socket.all.at(-1);
  ws.emit("open");
  ws.event("TranscriptionStarted");
  return ws;
}

test("官方 SDK 生成签名请求所需的新版听悟参数，禁用摘要与重试", async () => {
  const api = new TingwuAPI({
    accessKeyId: "fake-id",
    accessKeySecret: "fake-secret",
  });
  const requests = [];
  api.client.callApi = async (params, request, runtime) => {
    requests.push({ params, request, runtime });
    return {
      body: { Code: "0", Data: { TaskId: "cloud-task", MeetingJoinUrl: URL } },
    };
  };
  const data = await api.create(
    { tingwuAppKey: "app", tingwuLanguage: "cn" },
    "lesson-key",
  );
  assert.equal(data.taskId, "cloud-task");
  const { params, request, runtime } = requests[0];
  assert.equal(params.authType, "AK");
  assert.equal(params.method, "PUT");
  assert.equal(params.pathname, "/openapi/tingwu/v2/tasks");
  assert.equal(request.query.type, "realtime");
  assert.equal(request.body.AppKey, "app");
  assert.equal(request.body.Input.SampleRate, 16000);
  assert.equal(request.body.Input.TaskKey, "lesson-key");
  assert.equal(request.body.Parameters.Transcription.OutputLevel, 2);
  assert.equal(request.body.Parameters.SummarizationEnabled, false);
  assert.equal(runtime.autoretry, false);
  await api.stop("cloud-task");
  assert.equal(requests[1].request.query.operation, "stop");
  assert.equal(requests[1].request.body.Input.TaskId, "cloud-task");
});
test("SDK 异常不向界面泄露凭据或带授权的推流地址", async () => {
  const api = new TingwuAPI({ accessKeyId: "fake", accessKeySecret: "SECRET" });
  api.client.createTaskWithOptions = async () => {
    throw Object.assign(new Error(`SECRET ${URL}`), {
      code: "InvalidAccessKeyId",
    });
  };
  await assert.rejects(
    api.create({}),
    (e) =>
      !e.message.includes("SECRET") &&
      !e.message.includes("mc=") &&
      e.message.includes("InvalidAccessKeyId"),
  );
});
test("推流地址只接受官方北京 WSS 地址，拒绝重定向目标、凭据和伪子域", () => {
  assert.equal(meetingUrl(URL), URL);
  for (const url of [
    URL.replace("wss:", "ws:"),
    URL.replace(".aliyuncs.com", ".aliyuncs.com.evil.test"),
    URL.replace("wss://", "wss://user:pass@"),
    URL.replace("/api/ws/v1", "/other"),
  ])
    assert.throws(() => meetingUrl(url));
});
test("24→16k 重采样跨任意帧边界一致，保留时长且抑制混叠", () => {
  function wave(hz) {
    const b = Buffer.alloc(48000);
    for (let i = 0; i < 24000; i++)
      b.writeInt16LE(
        Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / 24000)),
        i * 2,
      );
    return b;
  }
  const input = wave(1000),
    whole = new PCMResampler().push(input),
    r = new PCMResampler(),
    parts = [];
  for (let i = 0; i < input.length; i += 254)
    parts.push(r.push(input.subarray(i, i + 254)));
  assert.equal(whole.length, 32000);
  assert.deepEqual(Buffer.concat(parts), whole);
  const rms = (b) => {
    let sum = 0;
    for (let i = 200; i < b.length; i += 2) sum += b.readInt16LE(i) ** 2;
    return Math.sqrt(sum / ((b.length - 200) / 2));
  };
  assert.ok(rms(whole) > 6800);
  assert.ok(rms(new PCMResampler().push(wave(10000))) < 200);
});
test("收到开始事件后才推送二进制 PCM，不发送 Bearer 或 base64 append", async () => {
  const f = fixture();
  f.asr.frame(f.frame, 90000, 90100);
  await tick();
  const ws = Socket.all.at(-1);
  assert.equal(ws.sent.length, 0);
  ws.emit("open");
  assert.equal(ws.sent[0].header.name, "StartTranscription");
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.options.followRedirects, false);
  assert.equal(ws.options.headers, undefined);
  ws.event("TranscriptionStarted");
  assert.equal(ws.sent[1].length, 3200);
  assert.ok(Buffer.isBuffer(ws.sent[1]));
  await f.asr.stop();
  assert.deepEqual(f.calls, ["cloud-1"]);
  assert.equal(f.state.streams[0].confirmed.at(-1).endMs, 90100);
});
test("临时字幕是替换结果；暂存下一句不入库，重复句末不重复写入", async () => {
  const f = fixture();
  const ws = await connect(f, 90000);
  ws.event("TranscriptionResultChanged", { index: 0, result: "北" });
  ws.event("TranscriptionResultChanged", { index: 0, result: "北京" });
  assert.deepEqual(f.partials.slice(-2), ["北", "北京"]);
  ws.event("SentenceBegin", { index: 0, time: 10 });
  const p = {
    index: 0,
    time: 100,
    result: "北京",
    words: [{ startTime: 10, endTime: 60 }],
    stash_result: { beginTime: 70, text: "天气" },
  };
  ws.event("SentenceEnd", p);
  ws.event("SentenceEnd", p);
  assert.equal(f.state.utterances.length, 1);
  assert.equal(f.state.utterances[0].text, "北京");
  assert.equal(f.state.utterances[0].startMs, 90010);
  assert.equal(f.state.streams[0].confirmed.at(-1).endMs, 90060);
  assert.equal(f.partials.at(-1), "天气");
  await f.asr.stop();
});
test("暂停完整收尾，恢复建立新任务并按采集时间映射，允许重复文本", async () => {
  const f = fixture();
  let ws = await connect(f, 1000);
  ws.event("SentenceEnd", {
    index: 0,
    time: 100,
    begin_time: 0,
    result: "强调",
  });
  await f.asr.pause();
  ws = await connect(f, 1100);
  ws.event("SentenceEnd", {
    index: 0,
    time: 100,
    begin_time: 0,
    result: "强调",
  });
  await f.asr.stop();
  assert.equal(f.state.utterances.length, 2);
  assert.equal(f.state.utterances[1].startMs, 1100);
  assert.deepEqual(f.calls, ["cloud-1", "cloud-2"]);
});
test("未收到完成事件不确认静音尾部，断网仅保留已确认覆盖", async () => {
  const f = fixture({ timeoutMs: 40 });
  const ws = await connect(f);
  ws.suppressComplete = true;
  await f.asr.stop();
  assert.equal(f.state.streams[0].confirmed.length, 0);
  assert.ok(f.warnings.some((w) => w.includes("尾句") || w.includes("超时")));
  assert.equal(f.calls.length, 1);
});
test("撤销授权拒绝迟到文本，仍结束云端任务", async () => {
  const f = fixture();
  const ws = await connect(f);
  f.c.consent.audio = false;
  ws.event("SentenceEnd", { index: 0, time: 100, result: "不应写入" });
  await f.asr.disconnect();
  assert.equal(f.state.utterances.length, 0);
  assert.equal(f.calls.length, 1);
});
test("创建任务期间取消，迟到的任务仍会被结束且不建立推流连接", async () => {
  let resolveCreate;
  const f = fixture({
    api: {
      create: () =>
        new Promise((r) => {
          resolveCreate = r;
        }),
    },
  });
  const previous = Socket.all.length;
  f.asr.frame(f.frame, 0, 100);
  const stopping = f.asr.disconnect();
  resolveCreate({ taskId: "late-task", meetingJoinUrl: URL });
  await stopping;
  assert.equal(Socket.all.length, previous);
  assert.deepEqual(f.calls, ["late-task"]);
});
test("停止 API 失败持久保留待处理任务，不重复结束或谎报已结束", async () => {
  const f = fixture({
    api: {
      stop: async () => {
        throw new Error("offline");
      },
    },
  });
  await connect(f);
  await f.asr.stop();
  await f.asr.disconnect();
  assert.equal(f.state.streams[0].cloudState, "stop-pending");
  assert.ok(f.warnings.some((w) => w.includes("尚未确认结束")));
});
test("连接拥塞时停止上传，不确认丢失音频", async () => {
  const f = fixture();
  const ws = await connect(f);
  ws.bufferedAmount = 999999;
  f.asr.frame(f.frame, 100, 200);
  await delay(130);
  await f.asr.stop();
  assert.equal(f.state.streams[0].confirmed.length, 0);
  assert.ok(f.warnings.some((w) => w.includes("拥塞")));
});
test("补传只回放未确认区间，失败时不标记整块完成", async (t) => {
  const f = fixture(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tingwu-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = Buffer.alloc(44 + 9600);
  wav.write("RIFF");
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt16LE(1, 22);
  const file = path.join(dir, "chunk.wav");
  fs.writeFileSync(file, wav);
  f.state.chunks.push({ lessonId: "l", startMs: 0, endMs: 200, path: file });
  f.state.streams.push({
    lessonId: "l",
    confirmed: [{ startMs: 0, endMs: 100 }],
  });
  assert.deepEqual(gapsFor(f.store, "l", 0, 200), [{ start: 100, end: 200 }]);
  const frames = [];
  const options = {
    signal: new AbortController().signal,
    ensureAllowed() {},
    reserve() {},
    onPartial() {},
    onError() {},
    factory: () => ({
      frame: (_b, start, end) => frames.push([start, end]),
      pause: async () => {},
      stop: async () => {},
      disconnect: async () => {},
    }),
  };
  await assert.rejects(
    replayTingwu(f.store, "l", {}, options),
    /未获得听悟确认/,
  );
  assert.deepEqual(frames, [[100, 200]]);
  assert.equal(f.state.chunks[0].transcribed, undefined);
});

test("上一段收尾失败的重试冷却不会停止当前健康连接的推流", async () => {
  const f = fixture();
  const old = await connect(f);
  f.asr.commit();
  await connect(f, 100);
  old.event("TaskFailed", {}, { status: 40000004 });
  f.asr.frame(f.frame, 200, 300);
  await f.asr.stop();
  assert.equal(f.state.streams[1].confirmed.at(-1).endMs, 300);
});
