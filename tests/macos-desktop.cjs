// macOS integration checks use fake audio and OS-permission fixtures; no cloud calls.
const { _electron: electron } = require("@playwright/test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

(async () => {
  if (process.platform !== "darwin") {
    console.log("macOS integration checks skipped on this platform");
    return;
  }
  const data = path.resolve(".test-data", "macos-" + Date.now());
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
    const page = await application.firstWindow();
    await page.getByText("打开示例课程", { exact: false }).click();
    await page.waitForSelector(".workspace");
    const snapshot = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    const lid = snapshot.lessons[0].id;
    await page.evaluate(async (config) => {
      await window.desktop.invoke("localAsr.configure", { backend: "cloud" });
      await window.desktop.invoke("provider.configure", {
        ...config,
        mode: "mock",
        textKey: "",
        asrKey: "",
      });
    }, snapshot.config);
    if (
      !["activation", "pending-close", "pending-delete"].includes(
        process.argv[2],
      )
    ) {
      async function permissions(status, granted) {
        await application.evaluate(
          ({ systemPreferences }, fixture) => {
            globalThis.permissionFixture = { ...fixture, asks: 0 };
            systemPreferences.getMediaAccessStatus = () =>
              globalThis.permissionFixture.status;
            systemPreferences.askForMediaAccess = async (kind) => {
              if (kind !== "microphone")
                throw new Error("Unexpected permission");
              globalThis.permissionFixture.asks++;
              return globalThis.permissionFixture.granted;
            };
          },
          { status, granted },
        );
      }
      async function start() {
        return page.evaluate(async (lessonId) => {
          try {
            await window.desktop.invoke("recording.start", { lessonId });
            return { started: true };
          } catch (error) {
            return { started: false, message: error.message };
          }
        }, lid);
      }
      await permissions("denied", false);
      const denied = await start();
      assert.equal(
        denied.started,
        false,
        "denied macOS microphone permission must prevent recording",
      );
      assert.match(denied.message, /麦克风/);
      assert.equal(
        await application.evaluate(() => globalThis.permissionFixture.asks),
        0,
      );

      await permissions("restricted", false);
      assert.equal((await start()).started, false);
      await permissions("not-determined", false);
      assert.equal((await start()).started, false);
      assert.equal(
        await application.evaluate(() => globalThis.permissionFixture.asks),
        1,
      );

      await permissions("not-determined", true);
      assert.equal((await start()).started, true);
      assert.equal(
        await application.evaluate(() => globalThis.permissionFixture.asks),
        1,
      );
      await delay(400);
      await page.evaluate(() => window.desktop.invoke("recording.stop"));
      await permissions("granted", true);
      assert.equal((await start()).started, true);
      assert.equal(
        await application.evaluate(() => globalThis.permissionFixture.asks),
        0,
      );
      await delay(400);
      // One valid tail sample exposes fractional-millisecond clocks deterministically.
      await application.evaluate(({ BrowserWindow, ipcMain }) => {
        const recorder = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().endsWith("/recorder.html"),
        );
        if (!recorder) throw new Error("Missing recorder window");
        ipcMain.emit(
          "capture:frame",
          { sender: recorder.webContents },
          Buffer.alloc(2),
        );
      });
      await page.evaluate(() => window.desktop.invoke("recording.stop"));
      const recorded = await page.evaluate(() =>
        window.desktop.invoke("snapshot"),
      );
      assert.ok(
        recorded.chunks.length >= 2,
        "fake recording must persist playable audio chunks",
      );
      assert.ok(
        Number.isInteger(recorded.lessons[0].captureMs),
        "capture and persisted positions must use integer milliseconds",
      );
      console.log(
        "PASS: macOS denied/restricted/first-request/granted permission paths and audio persistence",
      );
    }

    async function deferredStart() {
      await application.evaluate(({ systemPreferences }) => {
        globalThis.resolveMicrophonePermission = null;
        systemPreferences.getMediaAccessStatus = () => "not-determined";
        systemPreferences.askForMediaAccess = () =>
          new Promise((resolve) => {
            globalThis.resolveMicrophonePermission = resolve;
          });
      });
      const request = page
        .evaluate(async (lessonId) => {
          try {
            await window.desktop.invoke("recording.start", { lessonId });
            return { started: true };
          } catch (error) {
            return { started: false, message: error.message };
          }
        }, lid)
        .catch(() => ({ started: false, windowClosed: true }));
      for (let i = 0; i < 100; i++) {
        if (
          await application.evaluate(
            () => !!globalThis.resolveMicrophonePermission,
          )
        )
          return { request };
        await delay(20);
      }
      throw new Error("Microphone permission request did not start");
    }
    // Return a wrapper: returning a Promise directly would await the permission here.
    if (!["activation", "pending-close"].includes(process.argv[2])) {
      const pending = await deferredStart();
      const lessonDeletion = await page.evaluate(async (lesson) => {
        try {
          await window.desktop.invoke("lesson.delete", {
            lessonId: lesson.id,
            confirm: lesson.name,
          });
          return { deleted: true };
        } catch {
          return { deleted: false };
        }
      }, snapshot.lessons[0]);
      const deletion = await page.evaluate(
        async ({ courseId, confirm }) => {
          try {
            await window.desktop.invoke("course.delete", {
              id: courseId,
              confirm,
            });
            return { deleted: true };
          } catch {
            return { deleted: false };
          }
        },
        { courseId: snapshot.courses[0].id, confirm: snapshot.courses[0].name },
      );
      await application.evaluate(() =>
        globalThis.resolveMicrophonePermission(false),
      );
      assert.equal((await pending.request).started, false);
      assert.equal(
        deletion.deleted,
        false,
        "deleting a course must not race an in-flight microphone start",
      );
      assert.equal(
        lessonDeletion.deleted,
        false,
        "deleting a lesson must not race an in-flight microphone start",
      );
      console.log(
        "PASS: a pending microphone request protects its lesson and course from deletion",
      );
    }
    const pendingClose =
      process.argv[2] !== "activation" ? await deferredStart() : null;
    await page.close();
    const exited = await Promise.race([
      application.waitForEvent("close").then(() => true),
      delay(1000).then(() => false),
    ]);
    assert.equal(
      exited,
      false,
      "closing the macOS window must keep the app available in the Dock",
    );
    if (pendingClose) {
      await application.evaluate(() =>
        globalThis.resolveMicrophonePermission(true),
      );
      await delay(400);
      const recorderCount = await application.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().endsWith("/recorder.html"),
          ).length,
      );
      assert.equal(
        recorderCount,
        0,
        "closing the window must cancel recording that is waiting for permission",
      );
      await pendingClose.request;
      console.log(
        "PASS: closing during permission does not start hidden recording",
      );
    }
    const reopening = application.waitForEvent("window", { timeout: 10000 });
    await application.evaluate(({ app }) => app.emit("activate"));
    const reopened = await reopening;
    await reopened.waitForSelector(".course-space, .workspace");
    const restored = await reopened.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    assert.equal(restored.lessons[0].id, lid);
    fs.mkdirSync("artifacts", { recursive: true });
    await reopened.screenshot({ path: "artifacts/macos-workspace.png" });
    console.log(
      "PASS: Dock activation recreates the window and retains course data",
    );
  } finally {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
