const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Store } = require("../electron/core.cjs");
const { Scheduler } = require("../electron/provider.cjs");

async function classroom(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lecture-scope-"));
  const store = await Store.open(dir);
  t.after(() => {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const course = store.createCourse("计算机网络");
  const first = store.createLesson(course.id, "第一堂课");
  const second = store.createLesson(course.id, "第二堂课", {
    noteId: first.noteId,
  });
  const old = store.addUtterance(first.id, "OLD_LECTURE 远程调用");
  store.addUtterance(second.id, "分组交换和排队时延。另提到路由协议。");
  const topic = store.topic(first.id, "分组交换");
  store.saveNote(topic.id, 0, "OLD_NOTE ![板书](attachment:board)", true, [
    {
      id: "old",
      kind: "transcript",
      lessonId: first.id,
      targetId: old.id,
      text: old.text,
    },
  ]);
  const slides = {
    id: "ppt",
    courseId: course.id,
    name: "课件.pdf",
    kind: "slides",
    sha: "s",
    pages: [
      "OUTSIDE_PPT 路由协议",
      "分组交换：存储转发",
      "排队时延：队列长度",
      "OUTSIDE_PPT 无线传输",
    ],
    outline: [
      { title: "全部章节", from: 1, to: 4 },
      { title: "范围外", from: 1, to: 1 },
    ],
  };
  const book = {
    id: "book",
    courseId: course.id,
    name: "教材.pdf",
    kind: "book",
    sha: "b",
    pages: [
      "排队时延随队列长度增加。",
      "OUTSIDE_BOOK 路由协议的原理",
      "分组交换是逐跳存储转发。",
      "OUTSIDE_BOOK 物理层编码",
    ],
    outline: [
      { title: "排队时延", from: 1, to: 1 },
      { title: "分组交换", from: 3, to: 3 },
    ],
  };
  store.tx((s) => {
    s.config.mode = "mock";
    s.materials.push(slides, book);
  });
  return { store, second, first, topic, slides, book };
}
function block(id, title, body, ...sources) {
  return {
    topic_id: id,
    title,
    content_md: body,
    source_ids: sources.map((s) => s.id),
    evidence_type: "teacher_explanation",
  };
}
const result = (...blocks) => ({ schema_version: "1", blocks });

test("选定课件限制证据和旧笔记上下文，教材只补充与所选页相关的内容，共享笔记保留原文", async (t) => {
  const { store, first, second, topic } = await classroom(t);
  store.setContext(second.id, {
    slides: { id: "ppt", from: 2, to: 3 },
    book: { id: "book", from: 4, to: 4 },
  });
  const task = store.enqueueWhole(second.id);
  const request = JSON.stringify(task.input);
  assert.doesNotMatch(request, /OUTSIDE_PPT|OUTSIDE_BOOK|OLD_LECTURE|OLD_NOTE/);
  assert.deepEqual(
    task.input.sources.filter((s) => s.targetId === "book").map((s) => s.page),
    [1, 3],
  );
  assert.doesNotMatch(JSON.stringify(task.input.structure), /范围外/);
  const page2 = task.input.sources.find(
    (s) => s.targetId === "ppt" && s.page === 2,
  );
  const textbook = task.input.sources.find((s) => s.targetId === "book");
  task.state = "running";
  assert.throws(
    () =>
      store.applyResult(
        task.id,
        result(block(topic.id, topic.title, "教材独立扩写", textbook)),
      ),
    /课件/,
  );
  assert.equal(store.s.candidates.length, 0);
  store.applyResult(
    task.id,
    result(block(topic.id, topic.title, "本课补充细节", page2)),
  );
  const candidate = store.s.candidates[0];
  store.candidate(candidate.id, true, topic.version);
  assert.match(topic.body, /OLD_NOTE !\[板书\]\(attachment:board\)/);
  assert.match(topic.body, /本课补充细节/);
  assert.equal(
    store.lessonTopics(first.id)[0].id,
    store.lessonTopics(second.id)[0].id,
  );
  assert.ok(topic.sources.some((s) => s.id === "old"));
});

test("教材或课件排序以引用页为准，整课分批仍保留本次课件证据", async (t) => {
  for (const [outlineSource, order] of [
    ["slides", ["分组交换", "排队时延"]],
    ["book", ["排队时延", "分组交换"]],
  ]) {
    const { store, first, second } = await classroom(t);
    const another = store.newNotebook(first.courseId, "顺序检查");
    store.updateLesson(second.id, { noteId: another.id });
    store.setContext(second.id, {
      slides: { id: "ppt", from: 2, to: 3 },
      book: { id: "book" },
      outlineSource,
    });
    const task = store.enqueueWhole(second.id);
    const calls = [];
    const scheduler = new Scheduler(
      store,
      () => "fixture",
      async (_config, _key, input) => {
        calls.push(input);
        const ref = (materialId, page) =>
          input.sources.find(
            (s) => s.targetId === materialId && s.page === page,
          );
        return result(
          block(
            "new:排队时延",
            "排队时延",
            "排队的课堂内容",
            ref("ppt", 3),
            ref("book", 1),
          ),
          block(
            "new:分组交换",
            "分组交换",
            "交换的课堂内容",
            ref("ppt", 2),
            ref("book", 3),
          ),
        );
      },
    );
    t.after(() => scheduler.close());
    await scheduler.run(task);
    assert.equal(task.state, "succeeded", task.error);
    assert.ok(calls.length > 0);
    assert.deepEqual(
      store.lessonTopics(second.id).map((s) => s.title),
      order,
    );
  }
});
