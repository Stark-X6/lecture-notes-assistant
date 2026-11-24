const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../electron/core.cjs");

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
