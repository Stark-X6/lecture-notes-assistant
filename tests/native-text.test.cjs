const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generate } = require("../electron/provider.cjs");
const { validateResult, DEFAULT_TEMPLATE } = require("../electron/core.cjs");

const urls = {
  openai: "https://api.openai.com/v1/responses",
  anthropic: "https://api.anthropic.com/v1/messages",
};
const input = {
  topics: [{ id: "section-id", title: "软件维护", path: "软件 / 维护" }],
  context: { topicId: "section-id" },
  chapterOutline: { materialId: "slide-id", requiresSlides: true },
  sources: [
    {
      id: "page-id",
      kind: "page",
      page: 2,
      targetId: "slide-id",
      materialRole: "slides",
      text: "所选课件",
    },
    {
      id: "transcript-id",
      kind: "transcript",
      topicId: "section-id",
      startMs: 8000,
      text: "所选课堂发言",
    },
  ],
};
const note = {
  schema_version: "1",
  blocks: [
    {
      topic_id: "H1",
      title: "软件维护",
      content_md: "讲义与课堂例子",
      source_ids: ["S1", "T1"],
      evidence_type: "teacher_explanation",
    },
  ],
};
const json = JSON.stringify(note);

function run(provider, fetcher, options = {}) {
  return generate(
    {
      mode: "http",
      textUrl: "https://example.invalid/old-endpoint",
      textModel: "fixture-model",
      textProvider: provider,
      textThinking: true,
      maxOutput: 2048,
      ...options.config,
    },
    "fixture-key",
    options.input || input,
    options.signal || new AbortController().signal,
    options.preview,
    fetcher,
  );
}
function reply(provider, content = json) {
  if (provider === "openai")
    return {
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "过程说明" }],
        },
        {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: content }],
        },
      ],
      usage: {
        input_tokens: 30,
        input_tokens_details: { cached_tokens: 7 },
        output_tokens: 12,
        total_tokens: 42,
      },
    };
  return {
    type: "message",
    role: "assistant",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "过程说明" },
      { type: "text", text: content },
    ],
    usage: {
      input_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
      output_tokens: 12,
    },
  };
}
// Split UTF-8 bytes, lines and SSE event boundaries independently of the JSON payload.
function stream(events) {
  const wire =
    ": ping\r\n\r\n" +
    events
      .map(
        (event) =>
          "event: " +
          event.type +
          "\r\n" +
          JSON.stringify(event, null, 1)
            .split("\n")
            .map((line) => "data: " + line)
            .join("\r\n") +
          "\r\n\r\n",
      )
      .join("");
  const bytes = Buffer.from(wire);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 11)
          controller.enqueue(bytes.subarray(i, i + 11));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

for (const provider of Object.keys(urls)) {
  test(
    provider +
      " 原生请求仅向官方端点发送选定资料，恢复章节、页和转录的真实引用",
    async () => {
      const signal = new AbortController().signal;
      const result = await run(
        provider,
        async (url, req) => {
          assert.equal(url, urls[provider]);
          assert.equal(req.signal, signal);
          assert.equal(req.redirect, "error");
          assert.equal(req.method, "POST");
          const headers = new Headers(req.headers);
          assert.equal(headers.get("content-type"), "application/json");
          const body = JSON.parse(req.body);
          assert.equal(body.stream, true);
          assert.equal(body.model, "fixture-model");
          assert.equal(body.thinking, undefined);
          let instructions, data, format;
          if (provider === "openai") {
            assert.equal(headers.get("authorization"), "Bearer fixture-key");
            assert.equal(headers.get("x-api-key"), null);
            assert.equal(body.store, false);
            assert.equal(body.max_output_tokens, 2048);
            assert.equal(body.max_tokens, undefined);
            assert.equal(body.messages, undefined);
            instructions = body.instructions;
            assert.equal(body.input[0].role, "user");
            data = JSON.parse(body.input[0].content);
            format = body.text.format;
            assert.equal(format.strict, true);
            assert.match(format.name, /^[a-zA-Z0-9_-]+$/);
          } else {
            assert.equal(headers.get("authorization"), null);
            assert.equal(headers.get("x-api-key"), "fixture-key");
            assert.match(
              headers.get("anthropic-version"),
              /^\d{4}-\d{2}-\d{2}$/,
            );
            assert.equal(body.max_tokens, 2048);
            assert.equal(body.max_output_tokens, undefined);
            instructions = body.system;
            assert.equal(body.messages.length, 1);
            assert.equal(body.messages[0].role, "user");
            data = JSON.parse(body.messages[0].content);
            format = body.output_config.format;
          }
          assert.match(instructions, /骨架/);
          assert.doesNotMatch(instructions, /所选课堂发言/);
          assert.equal(data.pages[0].id, "S1");
          assert.equal(data.transcript[0][2], "所选课堂发言");
          assert.equal(data.targetTopic, "H1");
          assert.doesNotMatch(
            req.body,
            /transcript-id|section-id|old-endpoint/,
          );
          assert.equal(format.type, "json_schema");
          assert.equal(format.schema.additionalProperties, false);
          assert.deepEqual(
            new Set(format.schema.required),
            new Set(["schema_version", "blocks"]),
          );
          assert.deepEqual(
            new Set(format.schema.properties.blocks.items.required),
            new Set([
              "title",
              "topic_id",
              "content_md",
              "source_ids",
              "evidence_type",
            ]),
          );
          return Response.json(reply(provider));
        },
        { signal },
      );
      assert.equal(result.blocks[0].content_md, "讲义与课堂例子");
      assert.equal(result.blocks[0].topic_id, "section-id");
      assert.deepEqual(result.blocks[0].source_ids, [
        "page-id",
        "transcript-id",
      ]);
      assert.equal(result._usage.prompt_tokens, 30);
      assert.equal(result._usage.completion_tokens, 12);
      validateResult(result, input);
    },
  );

  test(
    provider + " 为大纲、模板、学习任务分别传递可填写的结构化字段",
    async () => {
      const scenarios = [
        {
          input: {
            kind: "outline",
            role: "slides",
            from: 2,
            to: 3,
            pages: [{ page: 2, text: "独有资料" }],
          },
          result: {
            sections: [
              { key: "s1", parentKey: null, title: "第一节", from: 2, to: 3 },
            ],
          },
          fields: ["key", "parentKey", "title", "from", "to"],
        },
        {
          input: { kind: "template", preference: "独有资料" },
          result: { rules: DEFAULT_TEMPLATE },
          fields: Object.keys(DEFAULT_TEMPLATE),
        },
        {
          input: { kind: "study", sources: [{ text: "独有资料" }] },
          result: { schema_version: "1", blocks: [] },
          fields: [
            "topic_id",
            "title",
            "content_md",
            "source_ids",
            "evidence_type",
          ],
        },
      ];
      for (const scenario of scenarios) {
        const result = await run(
          provider,
          async (_, req) => {
            const body = JSON.parse(req.body);
            const user =
              provider === "openai" ? body.input[0] : body.messages[0];
            assert.equal(user.role, "user");
            assert.match(user.content, /独有资料/);
            assert.doesNotMatch(user.content, /local-transport-only/);
            const schema = (
              provider === "openai" ? body.text : body.output_config
            ).format.schema;
            const object =
              schema.properties.sections?.items ||
              schema.properties.rules ||
              schema.properties.blocks?.items;
            assert.equal(object.additionalProperties, false);
            assert.deepEqual(
              new Set(object.required),
              new Set(scenario.fields),
            );
            for (const key of scenario.fields)
              assert.ok(object.properties[key], key);
            return Response.json(
              reply(provider, JSON.stringify(scenario.result)),
            );
          },
          {
            input: {
              ...scenario.input,
              provider: { policy: "local-transport-only" },
              requestKey: "local-transport-only",
            },
          },
        );
        const { _usage, ...value } = result;
        assert.deepEqual(value, scenario.result);
      }
    },
  );
}

test("OpenAI 分片事件只预览最终消息，完成快照包含相同正文时不会重复", async () => {
  const preview = [];
  const result = await run(
    "openai",
    async () =>
      stream([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "comment",
            type: "message",
            role: "assistant",
            phase: "commentary",
          },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          item_id: "comment",
          delta: '{"content_md":"过程说明"}',
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            id: "answer",
            type: "message",
            role: "assistant",
            phase: "final_answer",
          },
        },
        {
          type: "response.output_text.delta",
          output_index: 1,
          item_id: "answer",
          delta: json.slice(0, json.indexOf("例子")),
        },
        {
          type: "response.output_text.delta",
          output_index: 1,
          item_id: "answer",
          delta: json.slice(json.indexOf("例子")),
        },
        {
          type: "response.output_text.done",
          output_index: 1,
          item_id: "answer",
          text: json,
        },
        { type: "response.completed", response: reply("openai") },
      ]),
    { preview: (value) => preview.push(value) },
  );
  assert.deepEqual(preview, ["讲义与课堂", "讲义与课堂例子"]);
  assert.deepEqual(result.blocks[0].source_ids, ["page-id", "transcript-id"]);
  assert.equal(result._usage.prompt_tokens, 30);
  assert.equal(result._usage.completion_tokens, 12);
});
test("Anthropic 分片事件只预览正文，保留输入缓存并以最后的累计输出计量", async () => {
  const preview = [];
  const result = await run(
    "anthropic",
    async () =>
      stream([
        {
          type: "message_start",
          message: {
            type: "message",
            content: [],
            stop_reason: null,
            usage: {
              input_tokens: 20,
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 7,
              output_tokens: 1,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: '{"content_md":"过程说明"}',
          },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: json },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 12 },
        },
        { type: "message_stop" },
      ]),
    { preview: (value) => preview.push(value) },
  );
  assert.deepEqual(preview, ["讲义与课堂例子"]);
  assert.deepEqual(result.blocks[0].source_ids, ["page-id", "transcript-id"]);
  assert.equal(result._usage.prompt_tokens, 30);
  assert.equal(result._usage.completion_tokens, 12);
});

test("原生错误、过滤、上下文限制与输出截断都有明确结果，合法 JSON 也无法绕过结束检查", async () => {
  const oa = reply("openai");
  const claude = reply("anthropic");
  const cases = [
    [
      "openai",
      Response.json({
        ...oa,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
      "MODEL_OUTPUT_LIMIT",
    ],
    [
      "openai",
      stream([
        {
          type: "response.incomplete",
          response: {
            ...oa,
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
          },
        },
      ]),
      "MODEL_INCOMPLETE_OUTPUT",
    ],
    [
      "openai",
      Response.json({
        ...oa,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "fixture" }],
          },
        ],
      }),
      "MODEL_INCOMPLETE_OUTPUT",
    ],
    [
      "openai",
      stream([{ type: "response.output_text.delta", delta: json }]),
      "MODEL_INCOMPLETE_OUTPUT",
    ],
    [
      "openai",
      stream([
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: "server_error", message: "fixture" },
          },
        },
      ]),
      "PROVIDER_ERROR",
    ],
    [
      "anthropic",
      Response.json({ ...claude, stop_reason: "max_tokens" }),
      "MODEL_OUTPUT_LIMIT",
    ],
    [
      "anthropic",
      Response.json({ ...claude, stop_reason: "refusal" }),
      "MODEL_INCOMPLETE_OUTPUT",
    ],
    [
      "anthropic",
      Response.json({
        ...claude,
        stop_reason: "model_context_window_exceeded",
      }),
      "CONTEXT_LIMIT",
    ],
    [
      "anthropic",
      stream([
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: json },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ]),
      "MODEL_INCOMPLETE_OUTPUT",
    ],
    [
      "anthropic",
      stream([
        {
          type: "error",
          error: { type: "overloaded_error", message: "fixture" },
        },
      ]),
      "PROVIDER_ERROR",
    ],
    [
      "anthropic",
      Response.json(
        {
          type: "error",
          error: {
            type: "request_too_large",
            message: "Request exceeds the maximum size",
          },
        },
        { status: 413 },
      ),
      "CONTEXT_LIMIT",
    ],
  ];
  for (const [provider, response, code] of cases) {
    await assert.rejects(
      run(provider, async () => response),
      { code },
      provider + " " + code,
    );
  }
});

for (const provider of Object.keys(urls)) {
  test(
    provider + " 流等待期间取消立即结束并停止读取",
    { timeout: 2000 },
    async () => {
      const controller = new AbortController();
      let started,
        cancelled = false;
      const ready = new Promise((r) => (started = r));
      const response = new Response(
        new ReadableStream(
          {
            pull() {
              started();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
      const result = run(provider, async () => response, {
        signal: controller.signal,
      });
      await ready;
      const reason = new Error("cancelled by fixture");
      controller.abort(reason);
      // The synthetic network source has no signal of its own.
      await assert.rejects(result, (e) => e === reason);
      assert.equal(cancelled, true);
    },
  );
}
test("已有 OpenAI Chat Completions 配置仍发送原来的消息和参数", async () => {
  const oldUrl = "https://api.openai.com/v1/chat/completions";
  const result = await run(
    undefined,
    async (url, req) => {
      assert.equal(url, oldUrl);
      const body = JSON.parse(req.body);
      assert.equal(body.messages[0].role, "system");
      assert.equal(body.max_tokens, 2048);
      assert.equal(body.text, undefined);
      assert.equal(body.response_format, undefined);
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: json } }],
      });
    },
    { config: { textUrl: oldUrl } },
  );
  assert.equal(result.blocks[0].topic_id, "section-id");
});
test("旧兼容服务可以继续逐行发送 data 而不插入空行", async () => {
  const packets = [
    { choices: [{ delta: { content: json.slice(0, 20) } }] },
    {
      choices: [{ delta: { content: json.slice(20) }, finish_reason: "stop" }],
    },
  ];
  const result = await run(
    "compatible",
    async () =>
      new Response(
        packets
          .map((packet) => "  data: " + JSON.stringify(packet))
          .join("\n") + "\ndata: [DONE]",
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  assert.equal(result.blocks[0].content_md, "讲义与课堂例子");
});
test("原生模型拒绝 max_tokens 设置时不会反复缩短输入资料", async () => {
  await assert.rejects(
    run("anthropic", async () =>
      Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "max_tokens: 300000 exceeds the output token limit of 128000",
          },
        },
        { status: 400 },
      ),
    ),
    { code: "MODEL_OUTPUT_SETTING" },
  );
});
