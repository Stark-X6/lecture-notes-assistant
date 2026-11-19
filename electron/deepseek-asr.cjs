const fs = require("node:fs");
const { check } = require("./core.cjs");

const URL = "https://api.deepseek.com/v1/tools/asr";
const LIVE_SEGMENT_MS = 30000;
const FILE_SEGMENT_MS = 90000;
const BYTES_PER_MS = 48;

async function transcribe(parts, secret, signal, reserve) {
  let header;
  const samples = parts.map(({ chunk, start, end }) => {
    const wav = fs.readFileSync(chunk.path);
    const from = Math.round((start - chunk.startMs) * 24) * 2;
    const to = Math.round((end - chunk.startMs) * 24) * 2;
    check(
      wav.length >= 44 &&
        wav.toString("ascii", 0, 4) === "RIFF" &&
        wav.readUInt16LE(20) === 1 &&
        wav.readUInt16LE(22) === 1 &&
        wav.readUInt32LE(24) === 24000 &&
        wav.readUInt16LE(34) === 16 &&
        wav.toString("ascii", 36, 40) === "data" &&
        from >= 0 &&
        44 + to <= wav.length + BYTES_PER_MS,
      "录音分片损坏或格式不受支持，无法提交 DeepSeek 转写",
    );
    header ||= wav.subarray(0, 44);
    return wav.subarray(44 + from, 44 + to);
  });
  const wav = Buffer.concat([header, ...samples]);
  const size = wav.length - 44;
  check(
    size > 0 && size <= 120000 * BYTES_PER_MS && wav.length <= 8 * 1024 * 1024,
    "录音分段超出 DeepSeek ASR 限制",
  );
  wav.writeUInt32LE(36 + size, 4);
  wav.writeUInt32LE(size, 40);
  const body = new FormData();
  body.append("file", new Blob([wav], { type: "audio/wav" }), "lecture.wav");

  signal.throwIfAborted();
  reserve();
  let response;
  try {
    response = await fetch(URL, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${secret}` },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error("DeepSeek 语音识别请求超时或连接失败，可补转写", {
      cause: error,
    });
  }
  check(
    response.ok,
    `DeepSeek 语音识别失败 (${response.status})，${[401, 403].includes(response.status) ? "请检查 API 密钥" : "已保留音频，可补转写"}`,
  );
  const result = await response.json().catch(() => null);
  check(
    typeof result?.text === "string" &&
      typeof result.request_id === "string" &&
      Number.isInteger(result.duration_ms) &&
      result.duration_ms >= 0 &&
      Math.abs(result.duration_ms - size / BYTES_PER_MS) <= 1000,
    "DeepSeek 返回无效的转写数据，已保留音频，可补转写",
  );
  return result.text.trim();
}

module.exports = { transcribe, LIVE_SEGMENT_MS, FILE_SEGMENT_MS };
