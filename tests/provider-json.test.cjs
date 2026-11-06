const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generate } = require("../electron/provider.cjs");

const config = {
  mode: "http",
  textUrl: "https://api.deepseek.com/chat/completions",
  textModel: "deepseek-flash",
  maxOutput: 3000,
};
const input = { kind: "template", rules: {}, preference: "简洁" };
const valid = '{"rules":{"custom_prompt":"保留例子"}}';
function response(content, finish_reason = "stop", reasoning_content) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content, reasoning_content },
          finish_reason,
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}
function sse(events) {
  return new Response(
    events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") +
      "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}
function run(fetcher, settings = config) {
  return generate(
    settings,
    "fixture-key",
    input,
    new AbortController().signal,
    () => {},
    fetcher,
  );
}
test("DeepSeek 请求使用 JSON 输出并关闭默认思考，不增加 token 上限", async () => {
  const result = await run(async (_, request) => {
    const body = JSON.parse(request.body);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.max_tokens, 3000);
    return response(valid);
  });
  assert.equal(result.rules.custom_prompt, "保留例子");
});
test("通用兼容接口不接收 DeepSeek 专属参数，原 JSON 代码围栏仍可解析", async () => {
  const result = await run(
    async (_, request) => {
      const body = JSON.parse(request.body);
      assert.equal(Object.hasOwn(body, "thinking"), false);
      assert.equal(Object.hasOwn(body, "response_format"), false);
      return response("```json\n" + valid + "\n```");
    },
    { ...config, textUrl: "https://example.com/v1/chat/completions" },
  );
  assert.equal(result.rules.custom_prompt, "保留例子");
});
test("非流式 length 即使碰巧是合法 JSON 也不能作为完整结果应用", async () => {
  await assert.rejects(
    run(async () => response(valid, "length")),
    (e) => e.code === "MODEL_OUTPUT_LIMIT",
  );
});
test("流式思考耗尽额度时报告截断，不把推理当作笔记或笼统报 JSON 错误", async () => {
  await assert.rejects(
    run(async () =>
      sse([
        { choices: [{ delta: { reasoning_content: "先分析资料" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
        { choices: [], usage: { completion_tokens: 3000 } },
      ]),
    ),
    (e) => e.code === "MODEL_OUTPUT_LIMIT",
  );
});
test("流式正确 JSON 后的 length 结束原因仍必须检查", async () => {
  await assert.rejects(
    run(async () =>
      sse([
        { choices: [{ delta: { content: valid } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
    ),
    (e) => e.code === "MODEL_OUTPUT_LIMIT",
  );
});
test("空白最终答案与只有思考内容的响应分别报错", async () => {
  await assert.rejects(
    run(async () => response("   ")),
    (e) => e.code === "MODEL_EMPTY_OUTPUT",
  );
  await assert.rejects(
    run(async () => response("", "stop", "只有思考")),
    (e) => e.code === "MODEL_REASONING_ONLY",
  );
});
test("被过滤或服务中断的结果不会进入 JSON 应用阶段", async () => {
  for (const reason of [
    "content_filter",
    "insufficient_system_resource",
    "aborted",
  ]) {
    await assert.rejects(
      run(async () => response(valid, reason)),
      (e) => e.code === "MODEL_INCOMPLETE_OUTPUT",
    );
  }
});
