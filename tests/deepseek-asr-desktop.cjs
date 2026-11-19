const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");
const { fakeCredentialStorage } = require("./helpers/macos-vault.cjs");
const { fakeMicrophonePermission } = require("./helpers/macos-permission.cjs");

async function main() {
  const data = mkdtempSync(path.join(tmpdir(), "lecture-deepseek-test-"));
  const executablePath = process.env.LECTURE_EXECUTABLE;
  const app = await electron.launch({
    executablePath,
    args: [
      ...(executablePath ? [] : ["."]),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env: { ...process.env, LECTURE_DATA_DIR: data },
  });
  try {
    await fakeCredentialStorage(app);
    await fakeMicrophonePermission(app);
    await app.evaluate(() => {
      globalThis.deepseekTest = { durations: [], failSecond: true };
      globalThis.fetch = async (url, options) => {
        if (
          String(url) !== "https://api.deepseek.com/v1/tools/asr" ||
          options.method !== "POST" ||
          options.redirect !== "error" ||
          options.headers.Authorization !== "Bearer fixture-deepseek" ||
          [...options.body.keys()].join(",") !== "file"
        )
          throw new Error("unexpected ASR request");
        const wav = Buffer.from(await options.body.get("file").arrayBuffer());
        const durationMs = (wav.length - 44) / 48;
        if (
          wav.toString("ascii", 0, 4) !== "RIFF" ||
          wav.readUInt32LE(24) !== 24000 ||
          wav.readUInt32LE(40) !== wav.length - 44 ||
          wav.length > 8 * 1024 * 1024 ||
          durationMs > 120000
        )
          throw new Error("invalid audio");
        deepseekTest.durations.push(durationMs);
        if (deepseekTest.failSecond && deepseekTest.durations.length === 2)
          return new Response("", { status: 503 });
        return Response.json({
          request_id: "fixture-" + deepseekTest.durations.length,
          text: "DeepSeek 测试字幕",
          duration_ms: Math.round(durationMs),
        });
      };
    });
    const page = await app.firstWindow();
    await page.waitForSelector(".onboarding");
    const call = (method, args = {}) =>
      page.evaluate(({ method, args }) => window.desktop.invoke(method, args), {
        method,
        args,
      });
    const course = await call("course.create", { name: "语音识别测试" });
    const lesson = await call("lesson.create", {
      courseId: course.id,
      name: "导入音频",
    });
    await call("localAsr.configure", { backend: "cloud" });
    await page.getByRole("button", { name: "API 与设置", exact: true }).click();
    await page.getByLabel("工作模式").selectOption("http");
    await page.getByLabel("语音提供商").selectOption("deepseek");
    await page.getByLabel("DeepSeek 语音 API 密钥").fill("fixture-deepseek");
    await page
      .getByRole("button", { name: "保存 API 配置", exact: true })
      .click();
    await page.getByText("配置已保存。请重新勾选下面的课程授权。").waitFor();
    await page.getByTitle("关闭对话框").click();
    await page.evaluate(
      (lessonId) =>
        window.desktop.invoke("audio.store", {
          lessonId,
          pcm: new Int16Array(190 * 24000).buffer,
        }),
      lesson.id,
    );
    const backfill = () => call("audio.backfill", { lessonId: lesson.id });
    await assert.rejects(backfill, /授权/);
    assert.deepEqual(await app.evaluate(() => deepseekTest.durations), []);
    await call("lesson.consent", { courseId: course.id, audio: true });
    await assert.rejects(backfill, /503/);
    assert.equal((await call("snapshot")).utterances.length, 1);
    assert.equal((await backfill()).count, 2);
    const snapshot = await call("snapshot");
    assert.deepEqual(
      snapshot.utterances.map((u) => [u.startMs, u.endMs, u.provider]),
      [
        [0, 90000, "deepseek"],
        [90000, 180000, "deepseek"],
        [180000, 190000, "deepseek"],
      ],
    );
    assert.equal(
      snapshot.lessons.find((l) => l.id === lesson.id).readiness.complete,
      true,
    );
    assert.deepEqual(
      await app.evaluate(() => deepseekTest.durations),
      [90000, 90000, 90000, 10000],
    );
    assert.equal((await backfill()).count, 0);
    assert.equal(snapshot.config.hasDeepseekAsrKey, true);
    assert.ok(!JSON.stringify(snapshot).includes("fixture-deepseek"));

    const reprocess = await call("audio.retranscribe", { lessonId: lesson.id });
    await expect
      .poll(async () => {
        const state = await call("snapshot");
        return state.lessons.find((l) => l.id === reprocess.lessonId)?.readiness
          .complete;
      })
      .toBe(true);
    const live = await call("lesson.create", {
      courseId: course.id,
      name: "录音尾段",
    });
    await call("recording.start", { lessonId: live.id });
    await expect
      .poll(
        async () => {
          const state = await call("snapshot");
          return (
            state.utterances.some(
              (u) => u.lessonId === live.id && u.endMs >= 29998,
            ) &&
            state.chunks.some((c) => c.lessonId === live.id && c.endMs >= 34000)
          );
        },
        { timeout: 50000 },
      )
      .toBe(true);
    await call("recording.stop");
    const stopped = await call("snapshot");
    const liveSections = stopped.utterances.filter(
      (u) => u.lessonId === live.id,
    );
    assert.equal(liveSections.length, 2);
    assert.ok(liveSections.every((u) => u.provider === "deepseek"));
    assert.equal(
      stopped.lessons.find((l) => l.id === live.id).readiness.complete,
      true,
    );
    console.log(
      "PASS: DeepSeek setup, authorized upload, resumable backfill, re-transcription, classroom batch and recording tail",
    );
  } finally {
    await app.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
