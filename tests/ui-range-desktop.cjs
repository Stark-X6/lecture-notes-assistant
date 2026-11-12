const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { Store } = require("../electron/core.cjs");
(async () => {
  const data = path.resolve(".test-data", "range-ui-" + Date.now());
  const seed = await Store.open(data);
  seed.s.config.mode = "mock";
  seed.s.config.asrBackend = "cloud";
  const course = seed.createCourse("计算机网络"),
    notebook = seed.newNotebook(course.id, "网络原理笔记"),
    lesson = seed.createLesson(course.id, "第一讲 · 网络与分组交换", {
      noteId: notebook.id,
    });
  const topic = seed.topic(lesson.id, "分组交换"),
    next = seed.createLesson(course.id, "下一次课堂"),
    queue = seed.topic(lesson.id, "排队时延");
  seed.saveNote(queue.id, 0, "缓冲区中的分组需要等待发送。");
  seed.saveNote(seed.topic(next.id, "无关章节").id, 0, "另一份笔记的内容。");
  const timed = [
    seed.addUtterance(lesson.id, "网络边缘由端系统组成。", {
      startMs: 0,
      endMs: 10000,
    }),
    seed.addUtterance(lesson.id, "数据会被拆分成分组。", {
      startMs: 10000,
      endMs: 20000,
    }),
    seed.addUtterance(lesson.id, "路由器进行存储转发。", {
      startMs: 20000,
      endMs: 40000,
    }),
    seed.addUtterance(lesson.id, "在这之后讨论排队。", {
      startMs: 40000,
      endMs: 50000,
    }),
  ];
  const untimed = seed.addUtterance(lesson.id, "无时间戳的补充说明。");
  seed.db.close();
  const application = await electron.launch({
    ...(process.env.LECTURE_EXECUTABLE
      ? { executablePath: process.env.LECTURE_EXECUTABLE }
      : {}),
    args: process.env.LECTURE_EXECUTABLE ? [] : ["."],
    env: { ...process.env, LECTURE_DATA_DIR: data },
    timeout: 30000,
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /第一讲 · 网络与分组交换/ }).click();
    await page.waitForSelector(".workspace");
    const whole = page.getByRole("button", {
      name: "整理课堂笔记",
      exact: true,
    });
    await expect(whole).toBeVisible({ timeout: 2000 });
    assert.ok((await whole.boundingBox()).height >= 44);
    await page.getByRole("button", { name: "选择时间段", exact: true }).click();
    await page.getByLabel("开始时间", { exact: true }).fill("00:10");
    await page.getByLabel("结束时间", { exact: true }).fill("00:40");
    await page.getByPlaceholder("搜索课堂内容…").fill("路由器");
    await page.getByRole("button", { name: "选择范围", exact: true }).click();
    await expect(
      page.getByText("已选 2 段", { exact: false }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: /归入主题 \(2\)/ }).click();
    await page
      .locator(".selection-row")
      .filter({ hasText: "分组交换" })
      .click();
    const snap = () => page.evaluate(() => window.desktop.invoke("snapshot"));
    let state = await snap();
    const assigned = state.utterances
      .filter((u) => u.topicId === topic.id)
      .map((u) => u.id);
    assert.deepEqual(assigned, [timed[1].id, timed[2].id]);
    assert.equal(state.utterances.find((u) => u.id === timed[0].id).startMs, 0);
    await page.getByRole("button", { name: "选择时间段", exact: true }).click();
    await page.getByRole("button", { name: "选择范围", exact: true }).click();
    await page
      .getByRole("button", { name: "整理所选内容", exact: true })
      .click();
    await page.waitForFunction(async () =>
      (await window.desktop.invoke("snapshot")).tasks.some(
        (t) => t.state === "succeeded",
      ),
    );
    state = await snap();
    const task = state.tasks.find((t) => t.type === "notes");
    const submitted = state.events.find(
      (e) => e.type === "submission.created" && e.payload.taskId === task.id,
    );
    assert.deepEqual(
      submitted.payload.sourceIds.sort(),
      [timed[1], timed[2]].map((u) => `u:${u.id}:2`).sort(),
    );
    await page.getByRole("button", { name: "选择时间段", exact: true }).click();
    await page.getByRole("button", { name: "按段落", exact: true }).click();
    await page.getByLabel("起始段落", { exact: true }).fill("5");
    await page.getByLabel("结束段落", { exact: true }).fill("5");
    await page.getByRole("button", { name: "选择范围", exact: true }).click();
    await expect(
      page.getByText("已选 1 段", { exact: false }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: /下一次课堂/ }).click();
    await expect(page.getByText(/已选 \d+ 段/)).toHaveCount(0);
    await page.getByRole("button", { name: /第一讲 · 网络与分组交换/ }).click();
    await whole.click();
    await page.waitForFunction(async () =>
      (await window.desktop.invoke("snapshot")).tasks.some(
        (t) => t.lane === "background" && t.state === "succeeded",
      ),
    );
    state = await snap();
    const background = state.tasks.find((t) => t.lane === "background");
    const all = state.events.find(
      (e) =>
        e.type === "submission.created" && e.payload.taskId === background.id,
    );
    assert.equal(
      all.payload.sourceIds.length,
      5,
      "whole generation ignores a local selection",
    );
    await expect(page.locator(".candidate-badge")).toBeVisible();
    const rightColumn = page.locator(".workspace > .column").last();
    const splitter = await rightColumn
      .locator(".resize.horizontal")
      .boundingBox();
    const bounds = await rightColumn.boundingBox();
    await page.mouse.move(
      splitter.x + splitter.width / 2,
      splitter.y + splitter.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      splitter.x + splitter.width / 2,
      bounds.y + bounds.height - 60,
    );
    await page.mouse.up();
    assert.ok(
      (await page.locator(".transcript-panel").boundingBox()).height >= 280,
    );
    await expect(
      page.getByRole("button", { name: "整理待处理内容", exact: true }),
    ).toBeInViewport();

    await page.setViewportSize({ width: 1500, height: 970 });
    const panels = {
      课件: page.locator(".material-slides"),
      教材: page.locator(".material-book"),
      笔记: page.locator(".note-panel"),
      转录: page.locator(".transcript-panel"),
    };
    for (const name of Object.keys(panels)) {
      await page
        .getByRole("button", { name: "折叠" + name, exact: true })
        .click();
      await expect(panels[name]).toBeHidden();
      for (const [other, panel] of Object.entries(panels)) {
        if (other === name) continue;
        await expect(panel).toBeVisible();
        assert.ok(
          (await panel.boundingBox()).height >= 160,
          other + "被一同折叠",
        );
      }
      await page
        .getByRole("button", { name: "展开" + name, exact: true })
        .click();
      await expect(panels[name]).toBeVisible();
    }
    await page.getByRole("button", { name: "折叠课件", exact: true }).click();
    await page.getByRole("button", { name: "折叠教材", exact: true }).click();
    await expect(panels.课件).toBeHidden();
    await expect(panels.教材).toBeHidden();
    await page.getByRole("button", { name: "展开教材", exact: true }).click();
    await expect(panels.教材).toBeVisible();
    await expect(panels.课件).toBeHidden();
    await page.getByRole("button", { name: "展开课件", exact: true }).click();
    await expect(
      panels.笔记.getByRole("heading", { name: notebook.name }),
    ).toBeVisible();
    await expect(
      panels.笔记.getByRole("heading", { name: "分组交换" }),
    ).toBeVisible();
    await expect(
      panels.笔记.getByText("缓冲区中的分组需要等待发送。"),
    ).toBeVisible();
    await expect(panels.笔记.getByText("另一份笔记的内容。")).toHaveCount(0);
    await panels.笔记.getByRole("button", { name: /^排队时延/ }).click();
    await panels.笔记
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    await expect(panels.笔记.getByLabel("Markdown 笔记编辑器")).toHaveValue(
      "缓冲区中的分组需要等待发送。",
    );
    await expect(
      panels.笔记.getByRole("heading", { name: "分组交换" }),
    ).toBeVisible();
    await panels.笔记
      .getByRole("button", { name: "阅读", exact: true })
      .click();
    fs.mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/ui-classroom-wide.png" });
    await page.setViewportSize({ width: 1050, height: 720 });
    await expect(whole).toBeInViewport();
    await page.screenshot({ path: "artifacts/ui-classroom-compact.png" });
    await page.getByRole("button", { name: "课程空间", exact: true }).click();
    await page.setViewportSize({ width: 1500, height: 970 });
    await page
      .getByLabel("课程笔记", { exact: true })
      .selectOption(notebook.id);
    const document = page.locator(".studio-column article").filter({
      has: page.getByRole("heading", { name: notebook.name, exact: true }),
    });
    await expect(
      document.getByRole("heading", { name: /^分组交换/ }),
    ).toBeVisible();
    await expect(
      document.getByRole("heading", { name: /^排队时延/ }),
    ).toBeVisible();
    await page.screenshot({ path: "artifacts/ui-course-wide.png" });
    console.log(
      "PASS: range selection, shared note document and section editing, independent panel collapse, responsive classroom and course views",
    );
  } finally {
    await application.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
