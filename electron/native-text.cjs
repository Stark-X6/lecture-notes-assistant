const { fail } = require("./core.cjs");
const { failTextRequest } = require("./text-response.cjs");

const string = { type: "string" };
const integer = { type: "integer" };
const strings = (...values) => ({ type: "string", enum: values });
const array = (items) => ({ type: "array", items });
// Both native APIs accept closed objects with all fields required. The
// application still validates ranges, section membership and source IDs locally.
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const schemas = {
  notes: object({
    schema_version: strings("1"),
    blocks: array(
      object({
        topic_id: string,
        title: string,
        content_md: string,
        source_ids: array(string),
        evidence_type: strings(
          "teacher_explanation",
          "textbook_supplement",
          "inference",
        ),
      }),
    ),
  }),
  outline: object({
    sections: array(
      object({
        key: string,
        title: string,
        parentKey: { anyOf: [string, { type: "null" }] },
        from: integer,
        to: integer,
      }),
    ),
  }),
  template: object({
    rules: object({
      heading_numbering: strings("层级编号", "不编号", "中文序号"),
      detail_level: strings("标准", "简洁", "详细"),
      list_style: strings("项目符号", "保留原格式"),
      emphasis_style: strings("加粗标签", "纯文本"),
      source_format: strings("来源列表", "行内引用"),
      image_policy: strings("只给链接", "保留原图", "按需插入"),
      custom_prompt: string,
    }),
  }),
};

function nativeRequest(provider, config, key, kind, instructions, content) {
  const name = kind === "outline" || kind === "template" ? kind : "notes";
  const schema = schemas[name];
  const user = { role: "user", content: JSON.stringify(content) };
  if (provider === "openai")
    return {
      headers: { Authorization: `Bearer ${key}` },
      body: {
        model: config.textModel,
        stream: true,
        store: false,
        instructions,
        input: [user],
        max_output_tokens: config.maxOutput,
        text: { format: { type: "json_schema", name, strict: true, schema } },
      },
    };
  return {
    headers: { "x-api-key": key, "anthropic-version": "2026-10-21" },
    body: {
      model: config.textModel,
      stream: true,
      system: instructions,
      messages: [user],
      max_tokens: config.maxOutput,
      output_config: { format: { type: "json_schema", schema } },
    },
  };
}

function tokenUsage(raw, cachedSeparately = false) {
  if (!raw) return null;
  const usage = {};
  if (Number.isFinite(raw.input_tokens)) {
    usage.prompt_tokens = raw.input_tokens;
    if (cachedSeparately)
      usage.prompt_tokens +=
        (raw.cache_creation_input_tokens || 0) +
        (raw.cache_read_input_tokens || 0);
  }
  if (Number.isFinite(raw.output_tokens))
    usage.completion_tokens = raw.output_tokens;
  return Object.keys(usage).length ? usage : null;
}

function openAIParser(state, append) {
  const commentary = new Set();
  let refused = false;
  function reply(response, status = response.status) {
    if (response.error || status === "failed")
      failTextRequest(0, response.error);
    state.usage = tokenUsage(response.usage);
    if (Array.isArray(response.output)) {
      const parts = [];
      for (const item of response.output) {
        if (item.type === "reasoning") state.hasReasoning = true;
        if (item.type !== "message" || item.phase === "commentary") continue;
        for (const part of item.content || []) {
          if (part.type === "refusal") refused = true;
          if (part.type === "output_text") parts.push(part.text);
        }
      }
      // The completed snapshot includes the deltas already shown in previews.
      state.output = parts.join("");
    }
    if (
      status === "incomplete" &&
      response.incomplete_details?.reason === "max_output_tokens"
    )
      state.finishReason = "length";
    else
      state.finishReason =
        status === "completed" && !refused ? "stop" : "incomplete";
  }
  return {
    reply,
    event(value, eventName) {
      const type = value.type || eventName;
      switch (type) {
        case "error":
          failTextRequest(0, value.error || value);
          break;
        case "response.output_item.added":
          if (value.item?.phase === "commentary")
            commentary.add(value.output_index);
          if (value.item?.type === "reasoning") state.hasReasoning = true;
          break;
        case "response.output_text.delta":
          if (!commentary.has(value.output_index)) append(value.delta);
          break;
        case "response.refusal.delta":
        case "response.refusal.done":
          refused = true;
          break;
        case "response.completed":
        case "response.failed":
        case "response.incomplete":
          reply(
            value.response || {},
            value.response?.status || type.slice("response.".length),
          );
          break;
      }
    },
  };
}

function anthropicStop(reason) {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "model_context_window_exceeded":
      fail("CONTEXT_LIMIT", "模型上下文较小，正在调整分批大小");
      break;
    default:
      return "incomplete";
  }
}
function anthropicParser(state, append) {
  let usage, reason;
  function block(value) {
    if (value?.type === "text") append(value.text);
    if (value?.type === "thinking" || value?.type === "redacted_thinking")
      state.hasReasoning = true;
  }
  return {
    reply(message) {
      if (message.error) failTextRequest(0, message.error);
      state.finishReason = anthropicStop(message.stop_reason);
      state.usage = tokenUsage(message.usage, true);
      for (const part of message.content || []) block(part);
    },
    event(value, eventName) {
      switch (value.type || eventName) {
        case "error":
          failTextRequest(0, value.error);
          break;
        case "message_start":
          usage = { ...value.message?.usage };
          // The initial output count is provisional. Only settle it from a
          // message_delta, whose reported counters are cumulative.
          delete usage.output_tokens;
          for (const part of value.message?.content || []) block(part);
          break;
        case "content_block_start":
          block(value.content_block);
          break;
        case "content_block_delta":
          if (value.delta?.type === "text_delta") append(value.delta.text);
          if (value.delta?.type === "thinking_delta") state.hasReasoning = true;
          break;
        case "message_delta":
          reason = value.delta?.stop_reason || reason;
          usage = { ...usage, ...value.usage };
          break;
        case "message_stop":
          state.finishReason = anthropicStop(reason);
          state.usage = tokenUsage(usage, true);
          break;
      }
    },
  };
}

module.exports = { nativeRequest, openAIParser, anthropicParser };
