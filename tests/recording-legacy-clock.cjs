// An older Windows recording can end between two integer milliseconds.
const { _electron: electron } = require("@playwright/test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Store } = require("../electron/core.cjs");
const { fakeMicrophonePermission } = require("./helpers/macos-permission.cjs");
(async () => {
  const data = path.resolve(".test-data", "legacy-clock-" + Date.now());
  const seed = await Store.open(data);
  const course = seed.createCourse("旧版本计时恢复"),
    lesson = seed.createLesson(course.id, "第一课");
  seed.tx(() => {
    lesson.captureMs = 1000.5;
    seed.s.config.asrBackend = "cloud";
  });
  seed.db.close();
  const application = await electron.launch({
    ...(process.env.LECTURE_EXECUTABLE
      ? { executablePath: process.env.LECTURE_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.LECTURE_EXECUTABLE ? [] : ["."]),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env: { ...process.env, LECTURE_DATA_DIR: data },
    timeout: 30000,
  });
  try {
    await fakeMicrophonePermission(application);
    const page = await application.firstWindow();
    await page.waitForFunction(() => !!window.desktop);
    await page.evaluate(
      (lid) => window.desktop.invoke("recording.start", { lessonId: lid }),
      lesson.id,
    );
    await page.waitForTimeout(400);
    await page.evaluate(() => window.desktop.invoke("recording.stop"));
    const s = await page.evaluate(() => window.desktop.invoke("snapshot"));
    assert.ok(
      Number.isInteger(s.lessons[0].captureMs),
      "legacy recording must resume with an integer clock",
    );
    assert.ok(s.chunks.length > 0);
    assert.equal(s.chunks[0].startMs, 1001);
    console.log(
      "PASS: legacy fractional recording offsets resume with integer timestamps",
    );
  } finally {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
