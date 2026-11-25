const { check, fail } = require("./core.cjs");

function failTextRequest(status, error, native = false) {
  const code = error?.code || error?.type || "";
  const detail = code + " " + (error?.message || "");
  if (
    status === 401 ||
    status === 403 ||
    /^(invalid_api_key|authentication_error|permission_error)$/.test(code)
  )
    fail("AUTH_FAILED", "文本 API 认证失败，请检查当前服务的密钥和模型权限");
  if (
    status === 429 ||
    /^(rate_limit_error|rate_limit_exceeded|insufficient_quota)$/.test(code)
  )
    fail("RATE_LIMITED", "文本 API 限流或额度不足，请检查额度后重试");
  if (
    native &&
    status === 400 &&
    /\bmax_(output_)?tokens\b/i.test((error?.param || "") + " " + detail) &&
    !/context|prompt|input tokens/i.test(detail)
  )
    fail(
      "MODEL_OUTPUT_SETTING",
      "当前模型不支持这个单次输出上限，请按模型的额度调整设置后重试",
    );
  if (
    status === 413 ||
    /^(context_length_exceeded|request_too_large)$/.test(code) ||
    ((status === 400 || !status) &&
      /context|token.*limit|too.*long|maximum.*length/i.test(detail))
  )
    fail("CONTEXT_LIMIT", "模型上下文较小，正在调整分批大小");
  fail(
    "PROVIDER_ERROR",
    status
      ? `API 请求失败 (${status})；请检查地址、模型、权限或额度`
      : "文本服务返回错误，请检查服务状态后重试",
  );
}

function parseWireJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail("PROVIDER_ERROR", "文本服务返回了无法解析的响应");
  }
}

// An SSE event can span UTF-8 chunks and multiple data lines. Ignore comments
// and allow LF, CRLF and CR line endings, including split CRLF pairs.
function eventStream(parser) {
  let tail = [],
    data = [],
    event = "",
    afterCR = false;
  function dispatch() {
    const payload = data.join("\n").trim();
    if (payload === "[DONE]") parser.done?.();
    else if (payload) parser.event(parseWireJson(payload), event);
    data = [];
    event = "";
  }
  function line(value) {
    if (parser.perLine) value = value.trim();
    if (value === "") dispatch();
    else if (value.startsWith("data:")) {
      data.push(value.slice(5).replace(/^ /, ""));
      // Older Chat Completions gateways can use one data line per packet
      // without the blank lines that the native SSE protocols specify.
      if (parser.perLine) dispatch();
    } else if (value.startsWith("event:")) event = value.slice(6).trim();
  }
  return {
    push(chunk) {
      if (!chunk) return;
      const lines = chunk.split(/\r\n|[\r\n]/);
      if (afterCR && chunk.startsWith("\n")) lines.shift();
      afterCR = chunk.endsWith("\r");
      const last = lines.pop();
      for (const part of lines) {
        tail.push(part);
        line(tail.join(""));
        tail = [];
      }
      if (last) tail.push(last);
    },
    finish() {
      if (tail.length) line(tail.join(""));
      line("");
    },
  };
}

async function readTextResponse(response, maxBytes, signal, parser) {
  const stream = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? eventStream(parser)
    : null;
  if (!response.body) fail("PROVIDER_ERROR", "文本服务未返回响应正文");
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    parts = [];
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  let bytes = 0;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      check(bytes <= maxBytes, "响应超过当前输出额度的安全限制");
      const text = decoder.decode(value, { stream: true });
      if (stream) stream.push(text);
      else parts.push(text);
    }
    if (stream) {
      stream.push(decoder.decode());
      stream.finish();
    } else {
      parts.push(decoder.decode());
      parser.reply(parseWireJson(parts.join("")));
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

module.exports = { readTextResponse, failTextRequest };
