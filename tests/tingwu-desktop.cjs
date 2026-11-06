const { fakeCredentialStorage } = require("./helpers/macos-vault.cjs");
const { fakeMicrophonePermission } = require("./helpers/macos-permission.cjs");
// Isolated desktop integration test. All cloud traffic is replaced before recording.
const { _electron: electron } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
(async () => {
  const data = path.resolve(".test-data", "tingwu-desktop-" + Date.now());
  fs.mkdirSync("artifacts", { recursive: true });
  const application = await electron.launch({
    ...(process.env.LECTURE_EXECUTABLE
      ? { executablePath: process.env.LECTURE_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.LECTURE_EXECUTABLE ? [] : ["."]),
      "--no-sandbox",
      "--user-data-dir=" + path.join(data, "runtime"),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env: { ...process.env, LECTURE_DATA_DIR: data },
    timeout: 30000,
  });
  const ownedPid = await application.evaluate(() => process.pid);
  try {
    await fakeMicrophonePermission(application);
    await fakeCredentialStorage(application);
    const page = await application.firstWindow(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByText("打开示例课程", { exact: false }).click();
    await page.waitForSelector(".workspace");
    await application.evaluate(({ app }) => {
      const require = process
        .getBuiltinModule("node:module")
        .createRequire(app.getAppPath() + "/package.json");
      const path = require("node:path"),
        { EventEmitter } = require("node:events");
      const { TingwuAPI } = require(
        path.join(app.getAppPath(), "electron/tingwu-api.cjs"),
      );
      const { TingwuASR } = require(
        path.join(app.getAppPath(), "electron/tingwu-asr.cjs"),
      );
      globalThis.tingwuFixture = { created: [], stopped: [], bytes: 0 };
      TingwuAPI.prototype.create = async function (config) {
        if (config.tingwuAppKey !== "fixture-project")
          throw new Error("wrong project");
        const taskId =
          "fixture-" + (globalThis.tingwuFixture.created.length + 1);
        globalThis.tingwuFixture.created.push(taskId);
        return {
          taskId,
          meetingJoinUrl:
            "wss://tingwu-realtime-cn-beijing.aliyuncs.com/api/ws/v1?mc=fixture",
        };
      };
      TingwuAPI.prototype.stop = async function (taskId) {
        globalThis.tingwuFixture.stopped.push(taskId);
        return { taskStatus: "COMPLETED" };
      };
      class FakeSocket extends EventEmitter {
        constructor() {
          super();
          this.readyState = 1;
          this.bufferedAmount = 0;
          this.ms = 0;
          this.index = 0;
          setImmediate(() => this.emit("open"));
        }
        event(name, payload = {}) {
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                header: { name, status: 20000000, task_id: "stream-fixture" },
                payload,
              }),
            ),
          );
        }
        send(data) {
          if (Buffer.isBuffer(data)) {
            globalThis.tingwuFixture.bytes += data.length;
            this.ms += data.length / 32;
            if (this.ms >= (this.index + 1) * 200) {
              this.event("TranscriptionResultChanged", {
                index: this.index,
                result: "临时字幕",
              });
              const p = {
                index: this.index++,
                begin_time: Math.max(0, this.ms - 200),
                time: this.ms,
                result: "听悟桌面测试转录",
              };
              this.event("SentenceEnd", p);
              this.event("SentenceEnd", p);
            }
            return;
          }
          const e = JSON.parse(data);
          if (e.header.name === "StartTranscription")
            setImmediate(() => this.event("TranscriptionStarted"));
          if (e.header.name === "StopTranscription")
            setImmediate(() => this.event("TranscriptionCompleted"));
        }
        close() {
          this.readyState = 3;
          this.emit("close");
        }
        terminate() {
          this.close();
        }
      }
      const start = TingwuASR.prototype.start;
      TingwuASR.prototype.start = function (origin) {
        this.Socket = FakeSocket;
        return start.call(this, origin);
      };
    });
    await page.evaluate(() =>
      window.desktop.invoke("localAsr.configure", { backend: "cloud" }),
    );
    await page.getByRole("button", { name: "API 与设置", exact: true }).click();
    await page.getByLabel("工作模式").selectOption("http");
    await page.getByLabel("语音提供商").selectOption("tingwu");
    await page
      .getByLabel("听悟项目 AppKey", { exact: true })
      .fill("fixture-project");
    await page
      .getByLabel("AccessKey ID", { exact: true })
      .fill("fixture-id-only");
    await page
      .getByLabel("AccessKey Secret", { exact: true })
      .fill("fixture-secret-only");
    await page
      .getByRole("button", { name: "保存 API 配置", exact: true })
      .click();
    await page
      .getByText("配置已保存。请重新勾选下面的课程授权。", { exact: true })
      .waitFor();
    await page
      .getByLabel("允许发送麦克风音频与本课待补转写分片", { exact: true })
      .check();
    await page
      .getByRole("button", { name: "保存课程授权", exact: true })
      .click();
    await page.getByText("课程授权已保存", { exact: true }).waitFor();
    await page.screenshot({ path: "artifacts/tingwu-settings.png" });
    const snapshot = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    assert.equal(snapshot.config.hasTingwuId, true);
    assert.equal(snapshot.config.hasTingwuSecret, true);
    assert.ok(!JSON.stringify(snapshot).includes("fixture-secret-only"));
    assert.ok(!JSON.stringify(snapshot).includes("fixture-id-only"));
    await page.getByTitle("关闭对话框").click();
    await page.getByRole("button", { name: "开始录音", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".record-indicator")?.classList.contains("live"),
    );
    await page.waitForTimeout(650);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.getByRole("button", { name: "继续", exact: true }).waitFor();
    const paused = await page.evaluate(() => window.desktop.invoke("snapshot"));
    await page.waitForTimeout(250);
    assert.equal(
      (await page.evaluate(() => window.desktop.invoke("snapshot"))).lessons[0]
        .captureMs,
      paused.lessons[0].captureMs,
    );
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.waitForTimeout(650);
    await page.getByTitle("结束并保存录音").click();
    await page.getByRole("button", { name: "开始录音", exact: true }).waitFor();
    const final = await page.evaluate(() => window.desktop.invoke("snapshot"));
    const streams = final.streams.filter((s) => s.provider === "tingwu");
    const utterances = final.utterances.filter(
      (u) => u.text === "听悟桌面测试转录",
    );
    assert.equal(streams.length, 2);
    assert.ok(streams.every((s) => s.cloudState === "stopped"));
    assert.ok(
      Math.abs(streams[1].originMs - paused.lessons[0].captureMs) <= 1,
      "采样时钟与WAV毫秒四舍五入差异应在1ms内",
    );
    assert.ok(utterances.length >= 4);
    assert.equal(
      new Set(utterances.map((u) => u.streamId + u.providerSentenceId)).size,
      utterances.length,
    );
    assert.equal(streams[1].confirmed.at(-1).endMs, final.lessons[0].captureMs);
    assert.ok(final.chunks.length >= 2);
    assert.deepEqual(errors, []);
    const cloud = await application.evaluate(() => globalThis.tingwuFixture);
    assert.deepEqual(cloud.stopped, cloud.created);
    await page.screenshot({ path: "artifacts/tingwu-transcript.png" });
    console.log(
      JSON.stringify(
        {
          ui: "pass",
          sdkBoundary: "mocked",
          streams: streams.length,
          transcriptCount: utterances.length,
          cloud,
          data,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await application
      .windows()[0]
      ?.screenshot({ path: "artifacts/tingwu-failure.png" })
      .catch(() => {});
    throw error;
  } finally {
    try {
      process.kill(ownedPid);
    } catch {}
    application.process().kill();
  }
})()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
