const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { generate } = require("../electron/provider.cjs");
const { Store, validateResult } = require("../electron/core.cjs");
const config = {
  mode: "http",
  textUrl: "https://api.deepseek.com/chat/completions",
  textModel: "deepseek-flash",
  maxOutput: 300000,
  textThinking: true,
};
const input = { sources: [{ id: "u:one", text: "资料" }], topics: [] };
const block = (body) => ({
  schema_version: "1",
  blocks: [
    {
      topic_id: "new:主题",
      title: "主题",
      content_md: body,
      source_ids: ["u:one"],
      evidence_type: "teacher_explanation",
    },
  ],
});
function stream(events) {
  return new Response(
    events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
test("300000 token 请求可启用思考，并从分离的推理字段中只读取最终 JSON", async () => {
  const result = await generate(
    config,
    "fixture-key",
    input,
    new AbortController().signal,
    () => {},
    async (_, req) => {
      const body = JSON.parse(req.body);
      assert.equal(body.max_tokens, 300000);
      assert.deepEqual(body.thinking, { type: "enabled" });
      assert.deepEqual(body.response_format, { type: "json_object" });
      return stream([
        { choices: [{ delta: { reasoning_content: "思考".repeat(400000) } }] },
        {
          choices: [{ delta: { content: JSON.stringify(block("最终笔记")) } }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    },
  );
  assert.equal(result.blocks[0].content_md, "最终笔记");
  assert.equal(JSON.stringify(result).includes("reasoning_content"), false);
});
test("大额度允许超过旧 500K 字符的 JSON，流式预览仍有界", async () => {
  const text = "笔记".repeat(300000),
    previews = [],
    encoded = JSON.stringify(block(text));
  const result = await generate(
    config,
    "fixture-key",
    input,
    new AbortController().signal,
    (p) => previews.push(p),
    async () =>
      stream([
        ...Array.from(
          { length: Math.ceil(encoded.length / 32) },
          (_, index) => ({
            choices: [
              {
                delta: { content: encoded.slice(index * 32, (index + 1) * 32) },
              },
            ],
          }),
        ),
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
  );
  assert.equal(result.blocks[0].content_md, text);
  validateResult(result, input);
  assert.ok(
    previews.length > 0 &&
      previews.length <= 260 &&
      previews.every((p) => p.length <= 8000),
  );
});
test("长生成笔记可保存和再次人工编辑，超出总体安全上限仍拒绝", async (t) => {
  fs.mkdirSync(".test-data", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve(".test-data", "long-note-"));
  const s = await Store.open(dir);
  t.after(() => {
    s.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const course = s.createCourse("长笔记"),
    lesson = s.createLesson(course.id, "第一课"),
    topic = s.topic(lesson.id, "主题");
  const text = "笔记".repeat(300000);
  validateResult(block(text), input);
  s.saveNote(topic.id, 0, text);
  s.saveNote(topic.id, 1, text + "人工补充");
  assert.equal(topic.body, text + "人工补充");
  const tooLarge = "x".repeat(6291457);
  assert.throws(() => validateResult(block(tooLarge), input));
  assert.throws(() => s.saveNote(topic.id, 2, tooLarge));
});
test("小额度仍有响应安全边界，不因全局放宽而接受超大答案", async () => {
  await assert.rejects(
    generate(
      { ...config, maxOutput: 3000 },
      "fixture-key",
      input,
      new AbortController().signal,
      () => {},
      async () =>
        stream([
          {
            choices: [
              { delta: { content: JSON.stringify(block("x".repeat(600000))) } },
            ],
          },
        ]),
    ),
    /限制|过大/,
  );
});

test("思考或大输出课堂任务不再因旧18秒上限提前中止", async (t) => {
  fs.mkdirSync(".test-data", { recursive: true });
  const { Scheduler } = require("../electron/provider.cjs");
  for (const options of [
    { maxOutput: 300000, textThinking: false },
    { maxOutput: 3000, textThinking: true },
  ]) {
    const dir = fs.mkdtempSync(path.resolve(".test-data", "slow-generation-"));
    const s = await Store.open(dir);
    const scheduler = new Scheduler(
      s,
      () => "",
      async (_cfg, _key, value) => ({
        schema_version: "1",
        blocks: [
          {
            topic_id: value.topics[0].id,
            title: "主题",
            content_md: "完整笔记",
            source_ids: [value.sources[0].id],
            evidence_type: "teacher_explanation",
          },
        ],
      }),
    );
    t.after(() => {
      scheduler.close();
      s.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const c = s.createCourse("慢生成"),
      l = s.createLesson(c.id, "第一课");
    s.topic(l.id, "主题");
    s.tx(() => Object.assign(s.s.config, { mode: "mock", ...options }));
    s.addUtterance(l.id, "课堂资料");
    const task = s.enqueue(l.id);
    task.createdAt = Date.now() - 20000;
    await scheduler.run(task);
    assert.equal(task.state, "succeeded");
  }
});
