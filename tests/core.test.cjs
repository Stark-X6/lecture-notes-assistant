const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  Store,
  normalizeTime,
  parseSrt,
  validateResult,
} = require("../electron/core.cjs");
const { Scheduler, generate, endpoint } = require("../electron/provider.cjs");
async function fixture(t) {
  fs.mkdirSync(path.resolve(".test-data"), { recursive: true });
  const dir = fs.mkdtempSync(path.resolve(".test-data", "core-"));
  const store = await Store.open(dir);
  t.after(() => {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const c = store.createCourse("测试课程"),
    l = store.createLesson(c.id, "第一课"),
    topic = store.topic(l.id, "并发设计");
  store.tx((s) => (s.config.mode = "mock"));
  store.addUtterance(l.id, "录音与 AI 任务必须独立", {
    startMs: 0,
    endMs: 60000,
  });
  return { store, c, l, topic };
}
function result(t, topic) {
  return {
    schema_version: "1",
    blocks: [
      {
        topic_id: topic.id,
        title: topic.title,
        content_md: "录音与 AI 任务独立运行。",
        source_ids: [t.input.sources[0].id],
        evidence_type: "teacher_explanation",
      },
    ],
  };
}
test("笔记基线加入幂等键；相同快照复用，人工修改产生新任务", async (t) => {
  const { store, l, topic } = await fixture(t);
  const a = store.enqueue(l.id, { all: true }),
    b = store.enqueue(l.id, { all: true });
  assert.equal(a.id, b.id);
  store.saveNote(topic.id, 0, "人工备注");
  const c = store.enqueue(l.id, { all: true });
  assert.notEqual(c.key, a.key);
  assert.equal(c.input.topics[0].version, 1);
});
test("人工编辑保护、候选 CAS、恢复追加历史", async (t) => {
  const { store, l, topic } = await fixture(t);
  store.saveNote(topic.id, 0, "人工内容");
  const task = store.enqueue(l.id);
  task.state = "running";
  store.applyResult(task.id, result(task, topic));
  assert.equal(topic.body, "人工内容");
  const c = store.s.candidates[0];
  store.candidate(c.id, true, 1);
  assert.equal(topic.version, 2);
  const old = store.s.revisions.find((r) => r.version === 1);
  store.restore(old.id, 2);
  assert.equal(topic.body, "人工内容");
  assert.equal(topic.version, 3);
});
test("在途编辑导致过期候选，不能覆盖新版本", async (t) => {
  const { store, l, topic } = await fixture(t);
  const task = store.enqueue(l.id);
  task.state = "running";
  store.saveNote(topic.id, 0, "并发编辑");
  store.applyResult(task.id, result(task, topic));
  const c = store.s.candidates[0];
  assert.throws(() => store.candidate(c.id, true, 1), /基线已过期/);
  assert.equal(topic.body, "并发编辑");
});
test("纠错使依赖来源失效，旧模型结果成为候选", async (t) => {
  const { store, l, topic } = await fixture(t);
  const task = store.enqueue(l.id);
  task.state = "running";
  const u = store.s.utterances[0];
  store.revise(u.id, 1, "新的正确内容");
  store.applyResult(task.id, result(task, topic));
  assert.equal(topic.version, 0);
  assert.equal(store.s.candidates[0].reason, "转录已修订");
});
test("拒绝越界引用和未知主题，任务不能应用两次", async (t) => {
  const { store, l, topic } = await fixture(t);
  const task = store.enqueue(l.id);
  task.state = "running";
  const r = result(task, topic);
  r.blocks[0].source_ids = ["p:foreign:4"];
  assert.throws(() => store.applyResult(task.id, r), /未授权/);
  assert.equal(topic.version, 0);
  store.applyResult(task.id, result(task, topic));
  assert.equal(topic.version, 1);
  assert.throws(
    () => store.applyResult(task.id, result(task, topic)),
    /已取消/,
  );
});
test("主题人工归属校验课程范围，TXT 不编造时间", async (t) => {
  const { store, l, topic } = await fixture(t);
  const u = store.addUtterance(l.id, "无时间文本");
  assert.equal(u.startMs, null);
  store.assign(l.id, [u.id], topic.id);
  assert.equal(u.topicId, topic.id);
  const c2 = store.createCourse("另一课程"),
    l2 = store.createLesson(c2.id, "另一课"),
    t2 = store.topic(l2.id, "另一主题");
  assert.throws(() => store.assign(l.id, [u.id], t2.id), /本课主题/);
});
test("重连流时间转换与 SRT 时间顺序校验", () => {
  assert.deepEqual(normalizeTime({ originMs: 90000 }, 0, 1500), {
    startMs: 90000,
    endMs: 91500,
  });
  assert.throws(() => normalizeTime({ originMs: 0 }, 10, 0));
  assert.equal(
    parseSrt("1\n00:00:01,000 --> 00:00:03,000\n你好")[0].startMs,
    1000,
  );
  assert.throws(() => parseSrt("1\n00:00:03,000 --> 00:00:01,000\n错误"));
});
test("SQLite 持久化与中断恢复，密钥不进入快照", async (t) => {
  const { store, l } = await fixture(t);
  store.tx((s) => {
    s.secrets.text = "encrypted";
    l.recording = "recording";
  });
  const task = store.enqueue(l.id);
  task.state = "running";
  store.save();
  const second = await Store.open(store.root);
  second.recover();
  assert.equal(second.s.lessons[0].recording, "stopped");
  assert.equal(second.s.tasks[0].state, "failed");
  assert.equal(second.snapshot().secrets, undefined);
  second.db.close();
});
test("排队计入课堂截止时间，不调用已超时任务", async (t) => {
  const { store, l } = await fixture(t);
  const task = store.enqueue(l.id);
  task.createdAt = Date.now() - 19000;
  let called = false;
  const scheduler = new Scheduler(
    store,
    () => "",
    async () => {
      called = true;
    },
  );
  await scheduler.run(task);
  assert.equal(task.state, "failed");
  assert.match(task.error, /排队/);
  assert.equal(called, false);
  scheduler.close();
});
test("取消后迟到响应不能写入；停止 AI 不改变录音", async (t) => {
  const { store, l, topic } = await fixture(t);
  const task = store.enqueue(l.id);
  let resolve;
  const scheduler = new Scheduler(
    store,
    () => "",
    () => new Promise((r) => (resolve = r)),
  );
  const running = scheduler.run(task);
  scheduler.cancel(task.id);
  resolve(result(task, topic));
  await running;
  assert.equal(topic.version, 0);
  assert.equal(task.state, "cancelled");
  assert.equal(l.recording, "stopped");
  scheduler.close();
});
test("独立课堂并发 2 + 后台 1", async (t) => {
  const { store, l } = await fixture(t);
  store.enqueue(l.id);
  store.addUtterance(l.id, "第二段");
  store.enqueue(l.id);
  store.enqueue(l.id, { all: true });
  const pending = [];
  const scheduler = new Scheduler(
    store,
    () => "",
    () => new Promise((r) => pending.push(r)),
  );
  scheduler.tick();
  assert.equal(scheduler.running.size, 3);
  assert.equal(
    [...scheduler.running.values()].filter((x) => x.lane === "live").length,
    2,
  );
  scheduler.close();
  for (const r of pending) r({});
});
test("API SSE 分包、多字节和引用结构可以解析", async () => {
  const input = { kind: "template", rules: {}, preference: "中文" };
  const body = '{"rules":{"custom_prompt":"中文模板"}}';
  const chunks = [body.slice(0, 15), body.slice(15)];
  const response = new Response(
    chunks
      .map(
        (content) =>
          "data: " +
          JSON.stringify({ choices: [{ delta: { content } }] }) +
          "\n\n",
      )
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
  const output = await generate(
    {
      mode: "http",
      textUrl: "https://example.com/v1/chat/completions",
      textModel: "test",
      maxOutput: 300,
    },
    "secret",
    input,
    new AbortController().signal,
    () => {},
    async (_url, request) => {
      assert.equal(request.redirect, "error");
      assert.match(request.headers.Authorization, /Bearer/);
      return response;
    },
  );
  assert.equal(output.rules.custom_prompt, "中文模板");
});
test("API 地址只允许 HTTPS/WSS，禁止凭据内嵌", () => {
  assert.throws(() => endpoint("http://example.com"));
  assert.throws(() => endpoint("https://user:pass@example.com"));
  assert.equal(endpoint("https://example.com"), "https://example.com/");
});
test("连续点击同一提交点复用进行中任务", async (t) => {
  const { store, l } = await fixture(t);
  const a = store.enqueue(l.id);
  const b = store.enqueue(l.id);
  assert.equal(a.id, b.id);
  assert.equal(store.s.tasks.length, 1);
});
test("模板修订只影响新任务；保存旧任务原始输入", async (t) => {
  const { store, l, c } = await fixture(t);
  const a = store.enqueue(l.id);
  store.tx(() => {
    c.template.version++;
    c.template.rules.detail_level = "详细";
  });
  assert.equal(a.input.template.version, 1);
  assert.equal(a.input.template.rules.detail_level, "标准");
  const b = store.enqueue(l.id, { all: true });
  assert.equal(b.input.template.version, 2);
});
test("写盘失败不显示成功且回滚内存修改", async (t) => {
  const { store, topic } = await fixture(t);
  const save = store.save;
  store.save = () => {
    throw new Error("ENOSPC");
  };
  assert.throws(() => store.saveNote(topic.id, 0, "不能落盘"), /ENOSPC/);
  assert.equal(store.s.topics[0].body, "");
  store.save = save;
});
test("笔记上下文不会泄漏本次选页范围外的材料摘录", async (t) => {
  const { store, l, c, topic } = await fixture(t);
  store.tx((s) =>
    s.materials.push({
      id: "m",
      courseId: c.id,
      name: "教材",
      pages: ["当前页", "PRIVATE_PAGE_TWO"],
    }),
  );
  store.saveNote(topic.id, 0, "原有笔记", false, [
    {
      id: "p:m:2",
      kind: "material",
      targetId: "m",
      page: 2,
      text: "PRIVATE_PAGE_TWO",
    },
  ]);
  store.setContext(l.id, { book: { id: "m", from: 1, to: 1 } });
  const task = store.enqueue(l.id);
  assert.equal(JSON.stringify(task.input).includes("PRIVATE_PAGE_TWO"), false);
  task.state = "running";
  store.applyResult(task.id, result(task, topic));
  assert.equal(topic.body, "原有笔记");
  assert.equal(store.s.candidates[0].reason, "原笔记含本次范围外来源");
});
