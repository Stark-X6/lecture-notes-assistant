const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Store } = require("../electron/core.cjs");
const { Scheduler } = require("../electron/provider.cjs");
const { generate } = require("../electron/provider.cjs");

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

test("双语讲义从实际讲授的节名定位教材正文和连续页，剔除同名目录与索引", async (t) => {
  const { store, second, slides, book } = await classroom(t);
  slides.pages = [
    "Contents\n2.3 缓存 Cache\n2.4 日志 Journal\n本次讲解\n缓存 Cache（续）\n命中与淘汰",
  ];
  book.pages = [
    "TABLE OF CONTENTS\n2.3 Cache 80\n2.4 Journal 90",
    "About the Authors\nCache Journal",
    "80 CHAPTER 2 • STORAGE\nA local copy reduces the number of slow reads.",
    "2.3 • THE CACHE 81\nA miss fetches the data from storage.",
    "82 CHAPTER 2 • STORAGE\nDirty entries must be written back before eviction.",
    "2.3 • THE CACHE 83\nReplacement policies.",
    "2.4 • THE JOURNAL 84\nThe last point about eviction.\n2.4 The Journal",
    "86 CHAPTER 2 • STORAGE\nTransactions and records.",
    "2.4 • THE JOURNAL 87\nRecovery from failure.",
    "INDEX\nCache 80, 81, 83; Journal 84",
  ];
  store.setContext(second.id, {
    slides: { id: slides.id, from: 1, to: 1 },
    book: { id: book.id },
  });
  const input = store.enqueueWhole(second.id).input;
  const pages = input.sources
    .filter((s) => s.materialRole === "book")
    .map((s) => s.page);
  assert.deepEqual(pages, [3, 4, 5, 6, 7]);
});

test("实际请求仅发送一份转录文字，模型可用短引用准确指回原字幕修订与 PDF 页", async (t) => {
  const { store, second, slides } = await classroom(t);
  const u = store.addUtterance(second.id, "唯一的课堂例子", {
    startMs: 8100,
    endMs: 10500,
  });
  store.setContext(second.id, { slides: { id: slides.id, from: 2, to: 2 } });
  const input = store.enqueueWhole(second.id).input;
  const answer = await generate(
    {
      ...input.provider,
      mode: "http",
      textProvider: "compatible",
      textUrl: "https://example.org/chat",
      textModel: "fixture",
    },
    "fixture-test",
    input,
    new AbortController().signal,
    () => {},
    async (_, req) => {
      const payload = JSON.parse(req.body).messages.at(-1).content;
      assert.equal(payload.split(u.text).length - 1, 1);
      assert.ok(!payload.includes(u.id));
      const data = JSON.parse(payload);
      const passage = data.transcript.find((row) => row.at(-1) === u.text);
      const page = data.pages.find(
        (p) => p.materialRole === "slides" && p.page === 2,
      );
      const output = {
        schema_version: "1",
        blocks: [
          {
            topic_id: "new:授课例子",
            title: "授课例子",
            evidence_type: "teacher_explanation",
            content_md: "课堂例子",
            source_ids: [passage[0], page.id],
          },
        ],
      };
      return Response.json({
        choices: [
          {
            message: { content: JSON.stringify(output) },
            finish_reason: "stop",
          },
        ],
      });
    },
  );
  assert.deepEqual(answer.blocks[0].source_ids, [
    "u:" + u.id + ":1",
    "p:ppt:2:s",
  ]);
});

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

test("选页整课保留开场导读供查阅，用正文引用判别混合主题及教师强调", async (t) => {
  const { store, second, slides } = await classroom(t);
  slides.pages = [
    "本章提纲\n1.1 缓存的作用\n1.2 日志与恢复\n1.3 故障模型\n缓存机制\n用高速副本减少访问延迟。",
  ];
  store.s.utterances = [];
  const turns = [
    "本章后面会讲故障模型。",
    "第三节列举故障模式。",
    "后面也会讲日志记录。",
    "以上是本章的提纲。",
    "下面我们正式进入缓存。",
    "副本命中时缩短了等待时间。",
    "这个公式的前提必须掌握。",
  ].map((s) => store.addUtterance(second.id, s));
  store.setContext(second.id, { slides: { id: slides.id, from: 1, to: 1 } });
  const task = store.enqueueWhole(second.id);
  const slide = task.input.sources.find((s) => s.materialRole === "slides");
  const ref = (i) => task.input.sources.find((s) => s.targetId === turns[i].id);
  task.state = "running";
  store.applyResult(
    task.id,
    result(
      block("new:故障模型", "故障模型", "章节预告", slide, ref(0), ref(1)),
      block(
        "new:日志",
        "日志及恢复：方法",
        "章节预告和附带说明",
        slide,
        ref(0),
        ref(2),
        ref(5),
      ),
      block(
        "new:缓存",
        "缓存",
        "【教师强调】缓存副本可缩短访问时间。",
        slide,
        ref(5),
      ),
      block("new:前提", "使用前提", "【教师强调】公式前提。", slide, ref(6)),
    ),
  );
  assert.deepEqual(
    task.introduction?.map((b) => b.title),
    ["故障模型", "日志及恢复：方法"],
  );
  assert.equal(store.s.candidates.length, 2);
  assert.match(store.s.candidates[0].body, /【课堂讲解】/);
  assert.match(store.s.candidates[1].body, /【教师强调】/);
});

test("没有明确转场时，开头有目录也保留正常教学内容", async (t) => {
  const { store, second, slides } = await classroom(t);
  slides.pages = ["本章目录\n1.1 分组交换\n1.2 排队时延\n分组交换的具体步骤"];
  store.setContext(second.id, { slides: { id: slides.id, from: 1, to: 1 } });
  const task = store.enqueueWhole(second.id);
  task.state = "running";
  store.applyResult(
    task.id,
    result(
      block("new:分组交换", "分组交换", "课堂要点", ...task.input.sources),
    ),
  );
  assert.equal(task.introduction?.length || 0, 0);
  assert.equal(store.s.candidates.length, 1);
});
