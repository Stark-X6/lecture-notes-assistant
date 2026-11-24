const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Store } = require("../electron/core.cjs");

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "chapter-desktop-"));
  const store = await Store.open(data);
  const course = store.createCourse("借阅管理");
  const note = store.newNotebook(course.id, "共享章节笔记");
  const primary = {
    id: "primary",
    name: "借阅指南",
    kind: "book",
    ext: ".txt",
    sha: "primary-v1",
    courseId: course.id,
    pages: ["前一章", "借阅流程", "登记", "核查", "核查示例", "后一章"],
    outline: [
      { id: "root", title: "借阅流程", parentId: null, from: 2, to: 5 },
      { id: "register", title: "登记", parentId: "root", from: 2, to: 3 },
      { id: "check", title: "核查", parentId: "root", from: 4, to: 5 },
    ],
  };
  const slides = {
    id: "extra",
    name: "案例课件",
    kind: "slides",
    ext: ".txt",
    sha: "slides-v1",
    courseId: course.id,
    pages: [
      "核查时要复读证件号。",
      "今天午后天气晴朗。",
      "可以用条码代替手写。",
    ],
  };
  store.tx((state) => {
    state.config.mode = "mock";
    state.materials.push(primary, slides);
  });
  store.db.close();
  const app = await electron.launch({
    ...(process.env.LECTURE_EXECUTABLE
      ? { executablePath: process.env.LECTURE_EXECUTABLE }
      : {}),
    args: process.env.LECTURE_EXECUTABLE ? [] : ["."],
    env: { ...process.env, LECTURE_DATA_DIR: data },
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const call = (m, a = {}) =>
      page.evaluate(({ m, a }) => window.desktop.invoke(m, a), { m, a });
    const snapshot = () => call("snapshot");
    const button = (scope, name) =>
      scope.getByRole("button", { name, exact: true });
    const dialog = page.getByRole("dialog", { name: "章节笔记" });
    const open = async (label) => button(page, label).click();
    const close = async () => dialog.getByTitle("关闭对话框").click();
    const tab = (name) => page.getByRole("tab", { name, exact: true });
    const nav = dialog.getByRole("navigation", { name: "草稿章节" });
    const setPages = async (label, from, to) => {
      await dialog
        .getByLabel(label + "起始页", { exact: true })
        .fill(String(from));
      await dialog
        .getByLabel(label + "结束页", { exact: true })
        .fill(String(to));
    };
    await open("建立章节骨架");
    const mainMaterial = dialog.getByLabel("主要资料", { exact: true });
    await expect(dialog.getByLabel("骨架范围结束页")).toHaveValue("1");
    await mainMaterial.selectOption(slides.id);
    await expect(dialog.getByLabel("骨架范围结束页")).toHaveValue("3");
    await dialog.getByLabel("主要资料角色").selectOption("book");
    await expect(dialog.getByLabel("骨架范围结束页")).toHaveValue("1");
    await setPages("骨架范围", 2, 2);
    await dialog.getByLabel("主要资料角色").selectOption("slides");
    await expect(dialog.getByLabel("骨架范围结束页")).toHaveValue("2");
    await mainMaterial.selectOption(primary.id);
    await expect(dialog.getByLabel("主要资料角色")).toHaveValue("book");
    await expect(dialog.getByLabel("骨架范围结束页")).toHaveValue("1");
    await setPages("骨架范围", 2, 5);
    await button(dialog, "生成骨架预览").click();
    await expect(nav.getByRole("button")).toHaveCount(3);
    assert.equal((await snapshot()).topics.length, 0);
    await nav.getByRole("button", { name: /登记/ }).click();
    await dialog.getByLabel("章节标题").fill("登记要点");
    await setPages("章节来源", 3, 3);
    await nav.getByRole("button", { name: /核查/ }).click();
    await dialog.getByLabel("上级章节").selectOption("");
    await dialog.getByLabel("上级章节").selectOption({ label: "借阅流程" });
    await button(dialog, "上移").click();
    await close();
    await open("建立章节骨架");
    await expect(nav.getByRole("button").nth(1)).toContainText("核查");
    await expect(nav.getByRole("button").nth(2)).toContainText("登记要点");
    await button(dialog, "确认章节骨架").click();
    await expect(dialog.getByText(/已确认 3 个章节/)).toBeVisible();
    let state = await snapshot();
    assert.equal(state.lessons.length, 0);
    const notebook = state.notebooks.find((n) => n.id === note.id);
    const ids = notebook.outline.topicIds;
    const [parent, check, register] = ids.map((id) =>
      state.topics.find((t) => t.id === id),
    );
    assert.deepEqual(
      [parent.title, check.title, register.title],
      ["借阅流程", "核查", "登记要点"],
    );
    assert.equal(register.parentId, parent.id);
    assert.equal(register.outlineRange.from, 3);
    await call("note.save", {
      topicId: check.id,
      version: check.version,
      body: "我先写下的笔记。",
    });

    await dialog.getByRole("checkbox", { name: /案例课件/ }).check();
    await expect(dialog.getByLabel(slides.name + "补充起始页")).toHaveValue(
      "1",
    );
    await expect(dialog.getByLabel(slides.name + "补充结束页")).toHaveValue(
      "1",
    );
    await dialog.getByLabel("目标章节").selectOption(check.id);
    const submit = button(dialog, "提交本批补充");
    await submit.click();
    const review = dialog.locator(".chapter-review");
    await expect(review).toHaveCount(1);
    const baseline = (await snapshot()).topics.find((t) => t.id === check.id);
    await call("note.save", {
      topicId: check.id,
      version: baseline.version,
      body: "我先写下的笔记。\n\n后来手写的补记。",
    });
    await review.locator(":scope > summary").click();
    const columns = review.locator(".comparison > div");
    await expect(columns.nth(0)).toContainText("后来手写的补记");
    await expect(columns.nth(1)).toContainText(slides.pages[0]);
    await expect(columns.nth(1)).not.toContainText("我先写下的笔记");
    await button(review, "确认追加").click();
    await expect(review).toHaveCount(0);
    state = await snapshot();
    assert.match(
      state.topics.find((t) => t.id === check.id).body,
      /后来手写的补记/,
    );
    const count = state.tasks.filter((t) => t.supplement).length;
    await submit.click();
    await expect(dialog.getByRole("status")).toHaveText(/沿用原任务/);
    assert.equal(
      (await snapshot()).tasks.filter((t) => t.supplement).length,
      count,
    );
    await setPages(slides.name + "补充", 2, 2);
    await dialog.getByLabel("目标章节").selectOption("");
    await submit.click();
    await expect(dialog.getByText("未匹配章节", { exact: true })).toBeVisible();
    await close();
    const courseHeading = page
      .locator(".course-note .chapter-heading")
      .filter({ hasText: "登记要点" });
    await expect(courseHeading).toContainText("借阅流程");
    await expect(courseHeading).toContainText("借阅指南 · 第 3 页");

    const first = await call("lesson.create", {
      courseId: course.id,
      noteId: note.id,
      name: "周一借阅课",
    });
    const second = await call("lesson.create", {
      courseId: course.id,
      noteId: note.id,
      name: "周四借阅课",
    });
    await call("lesson.context", {
      lessonId: first.id,
      context: { slides: { id: slides.id, from: 2, to: 3 } },
    });
    const transcriptFile = path.join(data, "第一课.srt");
    fs.writeFileSync(
      transcriptFile,
      "1\n00:00:01,000 --> 00:00:03,000\n排除这条闲谈。\n\n2\n00:00:10,000 --> 00:00:12,000\n登记要点包含登记日期。\n",
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, transcriptFile);
    await page
      .locator(".lesson-list")
      .getByRole("button", { name: /周一借阅课/ })
      .click();
    await tab("转录").click();
    await button(page.getByRole("tabpanel", { name: "转录" }), "导入").click();
    await button(page, "选择时间段").click();
    await page.getByLabel("开始时间").fill("00:10");
    await page.getByLabel("结束时间").fill("00:12");
    await button(page, "选择范围").click();
    await tab("笔记").click();
    await open("按章节补充");
    await expect(
      dialog.getByRole("checkbox", { name: "使用转录页选中的 1 段" }),
    ).toBeChecked();
    await dialog.getByRole("checkbox", { name: /案例课件/ }).check();
    await expect(dialog.getByLabel(slides.name + "补充起始页")).toHaveValue(
      "2",
    );
    await expect(dialog.getByLabel(slides.name + "补充结束页")).toHaveValue(
      "3",
    );
    await setPages(slides.name + "补充", 3, 3);
    await dialog.getByLabel("目标章节").selectOption(register.id);
    await dialog.getByLabel("本批整理要求").fill("保留示例");
    await button(dialog, "去转录页选择").click();
    await expect(tab("转录")).toHaveAttribute("aria-selected", "true");
    await tab("笔记").click();
    await open("按章节补充");
    await expect(dialog.getByLabel("本批整理要求")).toHaveValue("保留示例");
    await expect(dialog.getByLabel(slides.name + "补充起始页")).toHaveValue(
      "3",
    );
    await submit.click();
    const body = async () =>
      (await snapshot()).topics.find((t) => t.id === register.id).body;
    await expect.poll(body).toContain("登记日期");
    assert.ok((await body()).includes(slides.pages[2]));
    assert.ok(!(await body()).includes("闲谈"));
    state = await snapshot();
    const firstRefs = state.topics.find((t) => t.id === register.id).sources;
    assert.deepEqual(
      firstRefs.filter((r) => r.kind === "transcript").map((r) => r.lessonId),
      [first.id],
    );
    assert.deepEqual(
      firstRefs.filter((r) => r.kind === "material").map((r) => r.page),
      [3],
    );
    await close();
    await call("transcript.add", {
      lessonId: second.id,
      text: "登记要点还要注明归还日期。",
    });
    await call("transcript.add", {
      lessonId: second.id,
      text: "下周上课换到西楼。",
    });
    await page
      .locator(".lesson-list")
      .getByRole("button", { name: /周四借阅课/ })
      .click();
    await tab("转录").click();
    await button(page, "整理待处理内容").click();
    await expect.poll(body).toContain("归还日期");
    await button(page, "逐句查看").click();
    const unmatched = page
      .locator(".transcript-sentence")
      .filter({ hasText: "下周上课换到西楼" });
    await expect(unmatched).toContainText("未匹配");
    await unmatched.getByRole("checkbox").check();
    await expect(button(page, "整理所选内容")).toBeEnabled();
    await tab("笔记").click();
    await open("按章节补充");
    await dialog.getByLabel("目标章节").selectOption(check.id);
    await submit.click();
    await expect(review).toHaveCount(1);
    await review.locator(":scope > summary").click();
    await button(review, "拒绝").click();
    await expect(review).toHaveCount(0);
    await close();
    await tab("转录").click();
    await expect(unmatched).toContainText("待提交");
    await tab("笔记").click();
    const heading = page
      .locator(".note-scroll .chapter-heading")
      .filter({ hasText: "登记要点" });
    await expect(heading).toContainText("借阅流程");
    await expect(heading).toContainText("第 3 页");
    state = await snapshot();
    assert.deepEqual(
      state.notebooks.find((n) => n.id === note.id).outline.topicIds,
      ids,
    );
    assert.deepEqual(
      state.topics.filter((t) => t.noteId === note.id).map((t) => t.id),
      ids,
    );
    const updated = state.topics.find((t) => t.id === register.id);
    assert.deepEqual(
      updated.sources
        .filter((r) => r.kind === "transcript")
        .map((r) => r.lessonId)
        .sort(),
      [first.id, second.id].sort(),
    );
    // The target notebook can collect a transcript from an older lesson that
    // still owns its original notebook. Select only its second paragraph.
    const old = await call("lesson.create", {
      courseId: course.id,
      name: "历史课堂",
    });
    assert.notEqual(old.noteId, note.id);
    await call("transcript.add", {
      lessonId: old.id,
      text: "历史课堂的未选段落。",
    });
    await call("transcript.add", {
      lessonId: old.id,
      text: "历史课堂提出使用登记序号。",
    });
    await button(page, "课程空间").click();
    await page.getByLabel("课程笔记", { exact: true }).selectOption(note.id);
    await open("按章节补充");
    await dialog.getByRole("checkbox", { name: /案例课件/ }).uncheck();
    await dialog.getByLabel("来源课堂").selectOption(old.id);
    await dialog.getByText("按时间或段落选择").click();
    await dialog.getByLabel("历史转录起始段落").fill("2");
    await dialog.getByLabel("历史转录结束段落").fill("2");
    await button(dialog, "选中该范围").click();
    await dialog.getByLabel("目标章节").selectOption(register.id);
    await submit.click();
    await expect.poll(body).toContain("历史课堂提出使用登记序号");
    assert.ok(!(await body()).includes("未选段落"));
    assert.equal(
      (await snapshot()).lessons.find((l) => l.id === old.id).noteId,
      old.noteId,
    );
    await close();
    await page
      .locator(".lesson-list")
      .getByRole("button", { name: /历史课堂/ })
      .click();
    await tab("转录").click();
    await expect(page.locator(".submit-bottom")).toContainText("2 段待处理");
    await button(page, "整理待处理内容").click();
    await expect
      .poll(async () => {
        const latest = await snapshot();
        const legacy = latest.tasks.find(
          (t) => t.lessonId === old.id && t.type === "notes" && !t.supplement,
        );
        return legacy?.state;
      })
      .toBe("succeeded");
    state = await snapshot();
    const oldTask = state.tasks.find(
      (t) => t.lessonId === old.id && t.type === "notes" && !t.supplement,
    );
    const sources = state.events.find(
      (e) => e.type === "submission.created" && e.payload.taskId === oldTask.id,
    ).payload.sourceIds;
    assert.equal(sources.filter((id) => id.startsWith("u:")).length, 2);
    const exportsDir = path.join(data, "exports");
    fs.mkdirSync(exportsDir);
    await app.evaluate(({ dialog, shell }, dir) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [dir],
      });
      shell.showItemInFolder = () => {};
    }, exportsDir);
    const courseExport = await call("study.export", {
      courseId: course.id,
      noteId: note.id,
    });
    const lessonExport = await call("note.export", { lessonId: second.id });
    for (const dir of [courseExport.directory, lessonExport]) {
      const markdown = fs.readFileSync(path.join(dir, "notes.md"), "utf8");
      assert.match(markdown, /^## 借阅流程$/m);
      assert.match(markdown, /^### 核查$/m);
      assert.match(markdown, /^### 登记要点$/m);
      assert.match(markdown, /借阅指南，第 3 页/);
      assert.ok(
        markdown.indexOf("### 核查") < markdown.indexOf("### 登记要点"),
      );
      assert.ok(markdown.includes("后来手写的补记"));
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: reviewed hierarchy before class, material and time-range batches, cross-notebook history, partial matches and rejection, safe append, shared chapters and both Markdown exports",
    );
  } catch (error) {
    const page = await app.firstWindow();
    console.error(
      "Desktop view at failure:",
      (await page.locator("body").innerText()).slice(-3000),
    );
    throw error;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
