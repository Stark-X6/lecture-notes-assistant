const { _electron: electron, expect } = require("@playwright/test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
(async () => {
  const data = path.resolve(".test-data", "study-ui-" + Date.now());
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync("artifacts", { recursive: true });
  const app = await electron.launch({
    ...(process.env.LECTURE_EXECUTABLE
      ? { executablePath: process.env.LECTURE_EXECUTABLE }
      : {}),
    args: process.env.LECTURE_EXECUTABLE ? [] : ["."],
    env: { ...process.env, LECTURE_DATA_DIR: data },
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForSelector(".onboarding");
    const call = (m, a = {}) =>
      page.evaluate(({ m, a }) => window.desktop.invoke(m, a), { m, a });
    const course = await call("course.create", {
      name: "软件工程 · v0.3 验收课程",
    });
    await page.waitForSelector(".course-space");
    let state = await call("snapshot");
    await call("provider.configure", {
      ...state.config,
      mode: "mock",
      textKey: "",
      asrKey: "",
    });
    // Course-only flow: no synthetic lesson is created to support chat/materials.
    assert.equal(state.lessons.length, 0);
    const file = path.join(data, "课程资料.md"),
      png = path.join(data, "example.png");
    fs.writeFileSync(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    fs.writeFileSync(
      file,
      "# 软件工程\n\n教师强调：需求必须可验证。\n\n行内公式 $x^2$ 与块公式：\n\n$$\nE=mc^2\n$$\n\n![示例](example.png)",
    );
    await app.evaluate(({ dialog, shell }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
      shell.showItemInFolder = () => {};
    }, file);
    await page
      .getByRole("button", { name: "导入教材 / 笔记", exact: true })
      .click();
    await page.waitForSelector(".course-note .katex");
    await page.waitForFunction(
      () => document.querySelector(".course-note img")?.naturalWidth > 0,
    );
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await page.getByLabel("课程问题").fill("如何验证需求？");
    await page
      .locator(".scope-picker .scope-item input[type=checkbox]")
      .first()
      .check();
    await page.getByRole("button", { name: "发送问题", exact: true }).click();
    await page.waitForSelector(".message.assistant");
    await page.getByLabel("课程问题").fill("保留未发送草稿");
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await expect(page.getByLabel("课程问题")).toHaveValue("");
    await page.getByRole("button", { name: "新对话 1", exact: true }).click();
    await expect(page.getByLabel("课程问题")).toHaveValue("保留未发送草稿");
    await page
      .getByRole("button", { name: "生成预习提纲", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        (await window.desktop.invoke("snapshot")).artifacts.length === 1,
    );
    await page.screenshot({ path: "artifacts/course-v03.png", fullPage: true });
    state = await call("snapshot");
    const notebook = state.notebooks[0],
      material = state.materials[0];
    const first = await call("lesson.create", {
        courseId: course.id,
        name: "11月6日课堂",
        noteId: notebook.id,
        startedAt: new Date("2026-11-06T08:00:00+08:00").getTime(),
      }),
      second = await call("lesson.create", {
        courseId: course.id,
        name: "11月13日课堂",
        noteId: notebook.id,
        startedAt: new Date("2026-11-13T08:00:00+08:00").getTime(),
      });
    for (const l of [first, second])
      await call("lesson.context", {
        lessonId: l.id,
        context: { slides: { id: material.id, from: 1, to: 1 } },
      });
    await call("transcript.add", {
      lessonId: second.id,
      text: "后续纠正：验证需要明确的条件和通过标准。",
    });
    await page.getByRole("button", { name: "课堂记录", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".lesson-record").length === 2,
    );
    assert.match(
      await page.locator(".lesson-record").first().innerText(),
      /11月13日课堂/,
    );
    await page
      .locator(".lesson-record")
      .first()
      .getByRole("button", { name: "进入课堂" })
      .click();
    await page.waitForSelector(".workspace");
    await page
      .getByRole("button", { name: "自动 · 课后整理", exact: true })
      .click();
    await page
      .getByRole("button", { name: "提交本段", exact: false })
      .isDisabled()
      .then((disabled) => assert.ok(disabled));
    await page.getByRole("button", { name: "折叠课件", exact: true }).click();
    assert.equal(await page.locator(".material-slides").isVisible(), false);
    await page.getByRole("button", { name: "展开课件", exact: true }).click();
    await page.getByRole("button", { name: "整课整理", exact: true }).click();
    await page.waitForFunction(
      async () =>
        (await window.desktop.invoke("snapshot")).candidates.length > 0,
    );
    await page.getByRole("button", { name: "课程空间", exact: true }).click();
    await page.waitForSelector(".course-space");
    assert.equal(
      (await call("snapshot")).lessons.filter((l) => l.noteId === notebook.id)
        .length,
      2,
    );
    const out = path.join(data, "export");
    fs.mkdirSync(out);
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [dir],
      });
    }, out);
    const exported = await call("study.export", {
      courseId: course.id,
      noteId: notebook.id,
    });
    assert.ok(
      fs
        .readFileSync(path.join(exported.directory, "notes.md"), "utf8")
        .includes("attachments/"),
    );
    assert.ok(
      fs.readdirSync(path.join(exported.directory, "attachments")).length,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        ui: "pass",
        flows: [
          "course-only chat",
          "draft isolation",
          "preview guide",
          "shared notebooks",
          "class dates",
          "whole lesson candidates",
          "panel collapse",
          "math",
          "managed images",
          "export attachments",
        ],
        data,
      }),
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
