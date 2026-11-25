const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../electron/core.cjs");
const { generate, Scheduler } = require("../electron/provider.cjs");

async function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lecture-text-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = await Store.open(dir);
  t.after(() => store.db.close());
  return store;
}

test("新资料库提供原生 OpenAI 端点，云端默认关闭", async (t) => {
  const store = await temporaryStore(t);
  const { config } = store.snapshot();
  assert.equal(config.mode, "off");
  assert.equal(config.textProvider, "openai");
  assert.equal(config.textUrl, "https://api.openai.com/v1/responses");
  assert.equal(config.hasTextKey, false);
});

test("升级只把旧密钥绑定原来的 Chat Completions 目标，保留课程授权和任务输入", async (t) => {
  for (const [url, provider] of [
    ["https://api.openai.com/v1/chat/completions", "compatible"],
    ["https://api.deepseek.com/chat/completions", "deepseek"],
    ["https://api.deepseek.com/v1/chat/completions", "compatible"],
    ["https://gateway.example:8443/company/chat?api-version=1", "compatible"],
    ["https://api.anthropic.com/v1/messages", "compatible"],
  ]) {
    const store = await temporaryStore(t);
    const course = store.createCourse("测试课程");
    const lesson = store.createLesson(course.id, "测试课次");
    store.addUtterance(lesson.id, "升级前的课次");
    store.tx((s) => {
      delete s.config.textProvider;
      Object.assign(s.config, {
        mode: "http",
        textUrl: url,
        textModel: "legacy-id",
        version: 7,
      });
      s.secrets = { text: "encrypted-legacy-key", asr: "encrypted-asr-key" };
      course.consent = { text: true, audio: false, version: 7 };
    });
    const job = store.enqueue(lesson.id);
    const updated = await Store.open(store.root);
    t.after(() => updated.db.close());
    const saved = updated.snapshot();
    assert.equal(saved.config.textProvider, provider, url);
    assert.equal(saved.config.textUrl, url);
    assert.equal(saved.config.textModel, "legacy-id");
    assert.equal(saved.config.version, 7);
    assert.deepEqual(saved.courses[0].consent, course.consent);
    assert.equal(saved.config.hasTextKey, true);
    assert.equal(saved.config.hasAsrKey, true);
    assert.doesNotMatch(JSON.stringify(saved), /encrypted-/);
    const { encryptedTextKey } = require("../electron/text-settings.cjs");
    const frozen = updated.s.tasks.find((task) => task.id === job.id).input
      .provider;
    assert.equal(frozen.textProvider, undefined);
    assert.equal(encryptedTextKey(updated.s, frozen), "encrypted-legacy-key");
    for (const target of [
      { textProvider: "openai" },
      { textProvider: "anthropic" },
      { textProvider: "compatible", textUrl: "https://other.example/chat" },
    ]) {
      assert.equal(encryptedTextKey(updated.s, target), "");
    }
  }
});

test("自定义端点缺失或无效时不能取得密钥，原生协议固定请求地址", () => {
  const {
    textTarget,
    textCredential,
  } = require("../electron/text-settings.cjs");
  for (const textUrl of [
    undefined,
    "",
    "http://gateway.example/chat",
    "https://me@gateway.example/chat",
    ["https://gateway.example/chat"],
  ]) {
    assert.equal(textCredential({ textProvider: "compatible", textUrl }), null);
    assert.equal(textCredential({ textUrl }), null);
  }
  assert.deepEqual(
    textTarget({
      textProvider: "anthropic",
      textUrl: "https://elsewhere.example/chat",
    }),
    {
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
    },
  );
  assert.throws(() => textTarget({ textProvider: "constructor" }), /提供商/);
});

test("旧离线库的无效地址不会把无归属密钥带入下一次配置或重启", async (t) => {
  const store = await temporaryStore(t);
  store.tx((s) => {
    delete s.config.textProvider;
    s.config.textUrl = "http://gateway.example/old";
    s.secrets.text = "unbound-ciphertext";
  });
  const upgraded = await Store.open(store.root);
  t.after(() => upgraded.db.close());
  assert.equal(upgraded.snapshot().config.hasTextKey, false);
  upgraded.tx((s) => {
    s.config.textUrl = "https://gateway.example/new";
  });
  const restarted = await Store.open(store.root);
  t.after(() => restarted.db.close());
  assert.equal(restarted.snapshot().config.hasTextKey, false);
  assert.doesNotMatch(
    JSON.stringify(restarted.snapshot()),
    /unbound-ciphertext/,
  );
});

test("兼容服务在结束标记之前断流时保留笔记，重试收到完成响应后才写入", async (t) => {
  const store = await temporaryStore(t);
  const course = store.createCourse("流式生成");
  const lesson = store.createLesson(course.id, "课堂");
  const topic = store.topic(lesson.id, "课堂小结");
  store.tx((s) => {
    Object.assign(s.config, {
      mode: "http",
      textProvider: "compatible",
      textModel: "fixture",
      textUrl: "https://example.invalid/chat",
    });
    course.consent.text = true;
  });
  store.addUtterance(lesson.id, "课堂讨论的结论");
  const task = store.enqueue(lesson.id);
  const answer = JSON.stringify({
    schema_version: "1",
    blocks: [
      {
        topic_id: topic.id,
        title: topic.title,
        content_md: "课堂讨论的结论",
        source_ids: [task.input.sources[0].id],
        evidence_type: "teacher_explanation",
      },
    ],
  });
  let requests = 0;
  const scheduler = new Scheduler(
    store,
    () => "fixture",
    (...args) =>
      generate(...args, async () => {
        const packets = [{ choices: [{ delta: { content: answer } }] }];
        if (++requests === 2)
          packets.push({
            choices: [{ finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 6 },
          });
        return new Response(
          packets.map((p) => "data: " + JSON.stringify(p) + "\n\n").join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
  );
  clearInterval(scheduler.timer);
  t.after(() => scheduler.close());
  await scheduler.run(task);
  assert.deepEqual([task.state, topic.version], ["failed", 0]);
  assert.match(task.error, /未正常完成/);
  scheduler.retry(task.id);
  await scheduler.run(task);
  assert.deepEqual([task.state, topic.version, requests], ["succeeded", 1, 2]);
  assert.match(topic.body, /课堂讨论的结论/);
  assert.deepEqual(task.usage, { prompt_tokens: 12, completion_tokens: 6 });
});

test(
  "暂停课次的后台重试让其他课程先运行，恢复后可完成原任务",
  { timeout: 5000 },
  async (t) => {
    const store = await temporaryStore(t);
    store.tx((s) => {
      s.config.mode = "mock";
    });
    function submit(name) {
      const course = store.createCourse(name);
      const lesson = store.createLesson(course.id, "第一课");
      store.addUtterance(lesson.id, name + "的讲解");
      return { lesson, task: store.enqueue(lesson.id, { all: true }) };
    }
    const scheduler = new Scheduler(store, () => "");
    clearInterval(scheduler.timer);
    t.after(() => scheduler.close());
    const paused = submit("暂停的课程");
    store.tx(() => {
      paused.lesson.aiPaused = true;
    });
    scheduler.cancel(paused.task.id);
    scheduler.retry(paused.task.id);
    const active = submit("继续整理的课程");
    async function runNext(task) {
      const finished = new Promise((resolve) => {
        store.onChange = () => {
          if (["failed", "succeeded"].includes(task.state)) resolve();
        };
      });
      scheduler.tick();
      assert.equal(task.state, "running");
      await finished;
      assert.equal(task.state, "succeeded", task.error);
    }
    await runNext(active.task);
    assert.deepEqual([paused.task.state, paused.task.attempt], ["queued", 0]);
    store.tx(() => {
      paused.lesson.aiPaused = false;
    });
    await runNext(paused.task);
    assert.equal(paused.task.attempt, 1);
  },
);
