const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Store } = require("../electron/core.cjs");

(async () => {
  const data = path.resolve(".test-data", "citations-ui-" + Date.now());
  const store = await Store.open(data);
  const course = store.createCourse("网络课程");
  const older = store.createLesson(course.id, "第一堂课");
  const current = store.createLesson(course.id, "第二堂课", {
    noteId: older.noteId,
  });
  const chapter = store.topic(older.id, "共享章节");
  const material = (id, name, kind, pages) => ({
    id,
    courseId: course.id,
    name,
    kind,
    pages,
    sha: id,
    ext: ".md",
  });
  const slides = material("slides", "本课课件", "slides", [
    "第一页",
    "第二页",
    "本课课件引用页",
  ]);
  const book = material("book", "本课教材", "book", ["当前教材"]);
  // The same file can be imported as slides and used as a textbook in a lesson.
  const oldBook = material("other", "往期读本", "slides", [
    "目录",
    "往期读本引用页",
    "附录",
  ]);
  store.tx((state) => state.materials.push(slides, book, oldBook));
  store.setContext(older.id, { book: { id: oldBook.id } });
  store.setContext(current.id, {
    slides: { id: slides.id, from: 1, to: 2 },
    book: { id: book.id },
  });
  const historic = store.addUtterance(older.id, "上一课老师的原话。", {
    startMs: 60000,
    endMs: 65000,
  });
  store.addUtterance(current.id, "可搜索的段落", { startMs: 0, endMs: 1000 });
  const local = store.addUtterance(current.id, "本课引用语句。", {
    startMs: 2000,
    endMs: 3000,
  });
  const transcript = (row, lesson) => ({
    id: "u:" + row.id + ":1",
    kind: "transcript",
    targetId: row.id,
    revision: row.revision,
    lessonId: lesson.id,
    text: row.text,
    startMs: row.startMs,
    endMs: row.endMs,
  });
  const legacy = transcript(local, current);
  delete legacy.text;
  delete legacy.revision;
  store.saveNote(chapter.id, 0, "参考本章的课堂与资料来源。", true, [
    {
      id: "p:slides:3",
      kind: "material",
      name: slides.name,
      targetId: slides.id,
      page: 3,
      text: slides.pages[2],
    },
    {
      id: "p:other:2",
      kind: "material",
      materialRole: "book",
      name: oldBook.name,
      targetId: oldBook.id,
      page: 2,
      text: oldBook.pages[1],
    },
    legacy,
    transcript(historic, older),
  ]);
  const contexts = store.s.lessons.map((lesson) => lesson.context);
  store.db.close();
  const app = await electron.launch({
    ...(process.env.LECTURE_EXECUTABLE
      ? { executablePath: process.env.LECTURE_EXECUTABLE }
      : {}),
    args: process.env.LECTURE_EXECUTABLE ? [] : ["."],
    env: { ...process.env, LECTURE_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /第二堂课/ }).click();
    const tab = (name) => page.getByRole("tab", { name, exact: true });
    const panel = (name) => page.getByRole("tabpanel", { name, exact: true });
    await expect(tab("课件")).toHaveAttribute("aria-selected", "true", {
      timeout: 2000,
    });
    await page.getByLabel("课程课件页码").fill("2");
    await panel("课件").getByRole("button", { name: "100%" }).click();
    await tab("教材").click();
    await tab("课件").click();
    await expect(page.getByLabel("课程课件页码")).toHaveValue("2");
    await expect(
      panel("课件").getByRole("button", { name: "130%" }),
    ).toBeVisible();
    await tab("笔记").click();
    await page.getByText(/章节来源（4）/).click();
    await expect(
      panel("笔记").getByRole("button", { name: /课堂转录 · 01:00/ }),
    ).toContainText(older.name, { timeout: 2000 });
    const cite = async (name) => {
      await tab("笔记").click();
      await panel("笔记").getByRole("button", { name }).click();
    };
    await cite(/本课课件 · 第 3 页/);
    await expect(panel("课件").getByText(slides.pages[2])).toBeVisible();
    await panel("课件").getByTitle("上一页").click();
    await cite(/本课课件 · 第 3 页/);
    await expect(page.getByLabel("课程课件页码")).toHaveValue("3");
    await cite(/往期读本 · 第 2 页/);
    await expect(panel("教材").getByText(oldBook.pages[1])).toBeVisible();
    await panel("教材").getByTitle("下一页").click();
    await tab("课件").click();
    await tab("教材").click();
    await expect(panel("教材").getByText(oldBook.pages[2])).toBeVisible();
    await panel("教材").getByRole("button", { name: "返回本课教材" }).click();
    await expect(panel("教材").getByText(book.pages[0])).toBeVisible();

    const search = page.getByPlaceholder("搜索课堂内容…");
    await tab("转录").click();
    await search.fill("可搜索");
    await cite(/课堂转录 · 00:02/);
    await expect(panel("转录").locator(".highlight")).toHaveText(local.text);
    await search.fill("可搜索");
    await cite(/课堂转录 · 00:02/);
    await expect(panel("转录").locator(".highlight")).toBeInViewport();
    await cite(/课堂转录 · 01:00/);
    await expect(page.locator(".breadcrumb")).toContainText(older.name);
    await expect(panel("转录").locator(".highlight")).toHaveText(historic.text);
    await expect(panel("转录").locator(".highlight")).toBeInViewport();
    await expect(panel("转录").getByText(local.text)).toHaveCount(0);
    await expect(
      panel("转录").getByRole("region", { name: "引用版本对照" }),
    ).toHaveCount(0);
    const revised = "老师更正后采用的表述。";
    await page.evaluate(
      ({ id, text }) =>
        window.desktop.invoke("transcript.revise", {
          id,
          revision: 1,
          text,
        }),
      { id: historic.id, text: revised },
    );
    await page.getByRole("button", { name: /第二堂课/ }).click();
    await tab("笔记").click();
    await page.getByText(/章节来源（4）/).click();
    await cite(/课堂转录 · 01:00/);
    await expect(panel("转录").locator(".highlight")).toHaveText(revised);
    const versions = panel("转录").getByRole("region", {
      name: "引用版本对照",
    });
    await expect(
      versions.getByText(historic.text, { exact: true }),
    ).toBeVisible({ timeout: 2000 });
    await expect(versions.getByText(revised, { exact: true })).toBeVisible();
    await expect(versions).toContainText("v1");
    await expect(versions).toContainText("v2");
    await page.evaluate(
      ({ id }) =>
        window.desktop.invoke("transcript.revise", {
          id,
          revision: 1,
          text: "本课修订后的原句。",
        }),
      { id: local.id },
    );
    await page.getByRole("button", { name: /第二堂课/ }).click();
    await tab("笔记").click();
    await page.getByText(/章节来源（4）/).click();
    await cite(/课堂转录 · 00:02/);
    await expect(versions.getByText(local.text, { exact: true })).toBeVisible();
    await expect(versions).toContainText("v1");
    const snapshot = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    assert.deepEqual(
      snapshot.lessons.map((lesson) => lesson.context),
      contexts,
    );
    assert.equal(
      snapshot.topics.find((t) => t.id === chapter.id).sources.at(-1).text,
      historic.text,
    );
    console.log(
      "PASS: independent material reading, repeated citations, cross-lesson sources and unchanged AI scope",
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
