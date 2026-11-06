const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Store } = require("../electron/core.cjs");
const { fakeMicrophonePermission } = require("./helpers/macos-permission.cjs");
(async () => {
  const mode = process.argv[2] || "live";
  const data = path.resolve(".test-data", `ui-safety-${mode}-${Date.now()}`);
  const s = await Store.open(data);
  s.s.config.mode = "mock";
  s.s.config.asrBackend = "cloud";
  const c = s.createCourse("界面安全回归"),
    l = s.createLesson(c.id, "第一课"),
    topic = s.topic(l.id, "知识点");
  s.addUtterance(l.id, "已经整理的定稿转录。", { startMs: 0, endMs: 10000 });
  const task = s.enqueue(l.id);
  task.state = "running";
  s.applyResult(task.id, {
    schema_version: "1",
    blocks: [
      {
        topic_id: topic.id,
        title: topic.title,
        content_md: "已有笔记",
        source_ids: [task.input.sources[0].id],
        evidence_type: "teacher_explanation",
      },
    ],
  });
  s.db.close();
  const app = await electron.launch({
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
    await fakeMicrophonePermission(app);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /第一课/ }).click();
    await page.waitForSelector(".workspace");
    if (mode === "live") {
      await page.getByRole("button", { name: "开始录音", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "暂停", exact: true }),
      ).toBeVisible();
      await app.evaluate(({ BrowserWindow, ipcMain }) => {
        const recorder = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().endsWith("/recorder.html"),
        );
        ipcMain.emit(
          "capture:frame",
          { sender: recorder.webContents },
          Buffer.alloc(960),
        );
      });
      const submit = page.getByRole("button", {
        name: "整理当前讲解",
        exact: true,
      });
      await expect(submit).toBeEnabled({ timeout: 2000 });
      await submit.click();
      await page.waitForFunction(async () =>
        (await window.desktop.invoke("snapshot")).lessons[0].windows.some(
          (w) => w.state === "waiting",
        ),
      );
      await page.getByTitle("结束并保存录音", { exact: true }).click();
    } else if (mode === "popup") {
      await page
        .locator(".workspace > .column")
        .last()
        .evaluate((el) => {
          el.style.gridTemplateRows = "minmax(180px,1fr) 8px 160px";
        });
      await page
        .getByRole("button", { name: "选择时间段", exact: true })
        .click();
      await expect(page.locator(".range-editor")).toBeInViewport({
        ratio: 1,
        timeout: 2000,
      });
      await expect(
        page.getByRole("button", { name: "选择范围", exact: true }),
      ).toBeInViewport({ ratio: 1 });
    } else if (mode === "draft") {
      await app.evaluate(({ app }) => {
        const require = process
          .getBuiltinModule("node:module")
          .createRequire(app.getAppPath() + "/package.json");
        const { Store } = require("./electron/core.cjs");
        Store.prototype.saveNote = () => {
          throw new Error("fixture_write_failure");
        };
      });
      await page
        .locator(".note-panel")
        .getByRole("button", { name: "编辑", exact: true })
        .click();
      const editor = page.getByLabel("Markdown 笔记编辑器", { exact: true });
      await editor.fill("不能丢失的人工草稿");
      await page
        .getByRole("button", { name: "学习工作台", exact: true })
        .click();
      await expect(editor).toBeVisible({ timeout: 2000 });
      await expect(editor).toHaveValue("不能丢失的人工草稿");
      await expect(page.getByRole("alert")).toContainText(
        "fixture_write_failure",
      );
    } else throw new Error("Unknown test mode");
    console.log("PASS: UI safety", mode);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
