const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { LiveASR } = require("../electron/asr.cjs");
class Socket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 1;
    this.bufferedAmount = 0;
    Socket.last = this;
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.emit("close");
  }
  event(e) {
    this.emit("message", Buffer.from(JSON.stringify(e)));
  }
}
function fixture() {
  const s = {
    config: {
      mode: "http",
      version: 1,
      asrUrl: "wss://example.com",
      asrModel: "test",
    },
    streams: [],
    utterances: [],
  };
  const lesson = { courseId: "c", aiPaused: false };
  const course = { consent: { audio: true, version: 1 } };
  const store = {
    s,
    lesson: () => lesson,
    course: () => course,
    tx: (fn) => fn(s),
  };
  const asr = new LiveASR(
    store,
    "l",
    "key",
    () => {},
    () => {},
    Socket,
  );
  const frame = Buffer.alloc(4800);
  for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(1000, i);
  return { asr, s, store, lesson, course, frame };
}
test("音频帧连接就绪后立即推流，不等待五秒落盘", () => {
  const { asr, frame } = fixture();
  asr.frame(frame, 0, 100);
  const ws = Socket.last;
  assert.equal(ws.sent.length, 0);
  ws.emit("open");
  ws.event({ type: "session.updated" });
  assert.equal(ws.sent[1].type, "input_audio_buffer.append");
  assert.equal(asr.lastEnd, 100);
  asr.disconnect();
});
test("跨连接起点、重复完成事件与相同文本的合理重复", () => {
  const { asr, s, frame } = fixture();
  asr.connect(90000);
  let ws = Socket.last;
  ws.emit("open");
  ws.event({ type: "session.updated" });
  asr.frame(frame, 90000, 90100);
  asr.commit();
  ws.event({ type: "input_audio_buffer.committed", item_id: "a" });
  ws.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "a",
    transcript: "重复强调",
  });
  ws.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "a",
    transcript: "重复强调",
  });
  assert.equal(s.utterances.length, 1);
  assert.equal(s.utterances[0].startMs, 90000);
  asr.disconnect();
  asr.nextConnect = 0;
  asr.connect(120000);
  ws = Socket.last;
  ws.emit("open");
  ws.event({ type: "session.updated" });
  asr.frame(frame, 120000, 120100);
  asr.commit();
  ws.event({ type: "input_audio_buffer.committed", item_id: "b" });
  ws.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "b",
    transcript: "重复强调",
  });
  assert.equal(s.utterances.length, 2);
  assert.equal(s.utterances[1].startMs, 120000);
  assert.equal(s.streams[1].confirmed[0].endMs, 120100);
  asr.disconnect();
});
test("撤销语音授权后，迟到事件不写入", () => {
  const { asr, s, course, frame } = fixture();
  asr.connect(0);
  const ws = Socket.last;
  ws.emit("open");
  ws.event({ type: "session.updated" });
  asr.frame(frame, 0, 100);
  asr.commit();
  ws.event({ type: "input_audio_buffer.committed", item_id: "a" });
  course.consent.audio = false;
  ws.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "a",
    transcript: "不得写入",
  });
  assert.equal(s.utterances.length, 0);
  asr.disconnect();
});
