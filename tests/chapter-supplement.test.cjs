const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os"),
  path = require("node:path");
const { Store, validateResult } = require("../electron/core.cjs");
const { Scheduler, generate } = require("../electron/provider.cjs");
const { routes } = require("../electron/study-routes.cjs");
async function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lecture-supplement-"));
  const store = await Store.open(dir);
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const course = store.createCourse("借阅管理");
  const lesson = store.createLesson(course.id, "第一堂");
  const note = store.s.notebooks[0],
    a = store.topic(lesson.id, "登记"),
    b = store.topic(lesson.id, "核查");
  const m = {
    id: "slides",
    sha: "edition1",
    courseId: course.id,
    name: "课件.pdf",
    kind: "slides",
    ext: ".pdf",
    pages: ["登记表的字段", "核查与记录", "第三节的课件"],
  };
  const book = {
    id: "book",
    sha: "edition2",
    courseId: course.id,
    name: "教材.pdf",
    kind: "book",
    ext: ".pdf",
    pages: ["登记页的例子", "核查时应复阅读者证件号", "无关的材料"],
  };
  store.tx((s) => {
    s.config.mode = "mock";
    s.materials.push(m, book);
    note.outline = {
      version: 1,
      topicIds: [a.id, b.id],
      materialId: m.id,
      role: "slides",
      from: 1,
      to: 2,
    };
    a.outlineRange = { materialId: m.id, from: 1, to: 1 };
    b.outlineRange = { materialId: m.id, from: 2, to: 2 };
  });
  const api = routes(() => ({ store }));
  const submit = (extra) =>
    api["notebook.supplement"]({
      courseId: course.id,
      noteId: note.id,
      ...extra,
    });
  return { store, course, lesson, note, a, b, m, book, submit };
}
function complete(store, task, topic, body, ids) {
  task.state = "running";
  store.applyResult(task.id, {
    schema_version: "1",
    blocks: [
      {
        topic_id: topic.id,
        title: topic.title,
        content_md: body,
        source_ids: ids,
        evidence_type: "teacher_explanation",
      },
    ],
  });
}
test("半自动分批只补骨架对应节，重复和重叠转录按原始修订去重", async (t) => {
  const { store, lesson, a, b } = await setup(t);
  const first = store.addUtterance(lesson.id, "登记时填卡号");
  const second = store.addUtterance(lesson.id, "核查时复读卡号");
  const job = store.enqueue(lesson.id, { uids: [first.id] });
  assert.ok(job.input.chapterOutline);
  assert.deepEqual(
    job.input.utterances.map((u) => u.id),
    [first.id],
  );
  complete(store, job, a, "登记补充", [job.input.sources[0].id]);
  assert.equal(b.body, "");
  assert.equal(store.enqueue(lesson.id, { uids: [first.id] }).id, job.id);
  const next = store.enqueue(lesson.id, { uids: [first.id, second.id] });
  assert.deepEqual(
    next.input.utterances.map((u) => u.id),
    [second.id],
  );
  complete(store, next, b, "核查补充", [next.input.sources[0].id]);
  assert.equal((a.body.match(/登记补充/g) || []).length, 1);
  assert.equal(store.s.topics.length, 2);
});
test("仅教材也能分批补充，空匹配可改为指定目标，越界或新主题不能写入", async (t) => {
  const { store, submit, a, b } = await setup(t);
  const materials = [{ id: "book", role: "book", from: 2, to: 2 }];
  const auto = submit({ materials });
  assert.equal(auto.input.utterances.length, 0);
  assert.deepEqual(
    auto.input.sources.map((s) => s.text),
    ["核查时应复阅读者证件号"],
  );
  auto.state = "running";
  assert.throws(
    () =>
      complete(store, auto, { id: "new:越界", title: "越界" }, "不应写入", [
        auto.input.sources[0].id,
      ]),
    /骨架|章节/,
  );
  assert.equal(store.s.topics.length, 2);
  store.applyResult(auto.id, { schema_version: "1", blocks: [] });
  assert.ok(auto.noMatch);
  assert.equal(a.version, 0);
  const job = submit({ materials, targetId: b.id });
  assert.notEqual(job.id, auto.id);
  assert.deepEqual(
    job.input.topics.map((x) => x.id),
    [b.id],
  );
  assert.throws(
    () => complete(store, job, a, "路由错节", [job.input.sources[0].id]),
    /骨架|章节/,
  );
  complete(store, job, b, "核查示例", [job.input.sources[0].id]);
  assert.equal(submit({ materials, targetId: b.id }).id, job.id);
  assert.throws(
    () => submit({ materials: [{ id: "book", role: "book", from: 2, to: 5 }] }),
    /页/,
  );
});
test("同节连续候选可逆序采用，保留后续人工批注和每批证据", async (t) => {
  const { store, submit, b } = await setup(t);
  store.saveNote(b.id, 0, "我的初稿");
  const one = submit({
    materials: [{ id: "book", role: "book", from: 1, to: 1 }],
    targetId: b.id,
  });
  const two = submit({
    materials: [{ id: "book", role: "book", from: 2, to: 2 }],
    targetId: b.id,
  });
  for (const [task, body] of [
    [one, "第一次补充"],
    [two, "第二次补充"],
  ])
    complete(store, task, b, body, [task.input.sources[0].id]);
  assert.equal(store.s.candidates.length, 2);
  assert.equal(store.s.candidates[0].kind, "append");
  store.saveNote(b.id, b.version, "我在生成后改了原稿 ^keep");
  for (const c of [...store.s.candidates].reverse())
    store.candidate(c.id, true, b.version);
  assert.match(b.body, /我在生成后改了原稿 \^keep/);
  assert.match(b.body, /第一次补充/);
  assert.match(b.body, /第二次补充/);
  assert.deepEqual(b.sources.map((x) => x.page).sort(), [1, 2]);
});
test("骨架被替换后的在途任务无部分写入，材料和转录均检查课程边界", async (t) => {
  const { store, note, submit, lesson, b } = await setup(t);
  const other = store.createCourse("外部课程");
  const l2 = store.createLesson(other.id, "其他课堂");
  const u = store.addUtterance(l2.id, "其他班原话");
  assert.throws(
    () => submit({ lessonId: lesson.id, uids: [u.id] }),
    /转录|课堂/,
  );
  const job = submit({
    materials: [{ id: "book", role: "book", from: 2, to: 2 }],
  });
  note.outline.version++;
  assert.throws(
    () => complete(store, job, b, "过期正文", [job.input.sources[0].id]),
    /骨架/,
  );
  assert.equal(b.version, 0);
  assert.equal(store.s.candidates.length, 0);
});
test("长批次保留完整骨架和材料页，显式目标不会丢失，纯教材正常归并", async (t) => {
  const { store, course, note, submit, b, book } = await setup(t);
  book.pages[1] = "核查说明".repeat(16000);
  const job = submit({
    materials: [{ id: "book", role: "book", from: 2, to: 2 }],
    targetId: b.id,
  });
  let calls = 0;
  const scheduler = new Scheduler(
    store,
    () => "test",
    async (cfg, k, input) => {
      calls++;
      assert.deepEqual(
        input.topics.map((x) => x.id),
        [b.id],
      );
      assert.ok(
        input.sources.every((s) => s.targetId === book.id && s.page === 2),
      );
      return {
        schema_version: "1",
        blocks: [
          {
            topic_id: b.id,
            title: "核查",
            content_md: "核查所得",
            source_ids: [input.sources[0].id],
            evidence_type: "textbook_supplement",
          },
        ],
      };
    },
  );
  t.after(() => scheduler.close());
  job.batchSize = 10000;
  await scheduler.run(job);
  assert.equal(job.state, "succeeded", job.error);
  assert.ok(calls >= 3);
  assert.match(b.body, /核查所得/);
});

test("重叠提交中先前任务取消后重新选择全段，会补回尚未处理的部分", async (t) => {
  const { store, lesson, a, b } = await setup(t);
  const x = store.addUtterance(lesson.id, "登记");
  const y = store.addUtterance(lesson.id, "核查");
  const reserved = store.enqueue(lesson.id, { uids: [x.id] });
  const following = store.enqueue(lesson.id, { uids: [x.id, y.id] });
  assert.deepEqual(
    following.input.utterances.map((u) => u.id),
    [y.id],
  );
  complete(store, following, b, "核查补充", [following.input.sources[0].id]);
  reserved.state = "cancelled";
  const recovered = store.enqueue(lesson.id, { uids: [x.id, y.id] });
  assert.deepEqual(
    recovered.input.utterances.map((u) => u.id),
    [x.id],
  );
  complete(store, recovered, a, "登记补充", [recovered.input.sources[0].id]);
  assert.equal(store.s.topics.length, 2);
});
test("真实请求契约使用局部章节和来源标识，保留层级并拒绝模型扩展目录", async (t) => {
  const { store, lesson, submit, a, b } = await setup(t);
  b.parentId = a.id;
  const task = submit({
    materials: [{ id: "book", role: "book", from: 2, to: 2 }],
    targetId: b.id,
  });
  const cfg = {
    ...task.input.provider,
    mode: "http",
    textUrl: "https://example.org/chat",
    textModel: "fixture",
  };
  async function answer(newId) {
    return generate(
      cfg,
      "fixture",
      task.input,
      new AbortController().signal,
      () => {},
      async (_, req) => {
        const wire = JSON.parse(JSON.parse(req.body).messages.at(-1).content);
        assert.equal(wire.transcript.length, 0);
        assert.equal(wire.topics.length, 1);
        assert.equal(wire.topics[0].path, "登记 / 核查");
        assert.equal(wire.targetTopic, wire.topics[0].id);
        assert.deepEqual(
          wire.pages.map((p) => p.page),
          [2],
        );
        assert.ok(!req.body.includes("第三节的课件"));
        const content = JSON.stringify({
          schema_version: "1",
          blocks: [
            {
              topic_id: newId || wire.topics[0].id,
              title: "核查",
              source_ids: [wire.pages[0].id],
              content_md: "核查号",
              evidence_type: "textbook_supplement",
            },
          ],
        });
        return Response.json({
          choices: [{ message: { content }, finish_reason: "stop" }],
        });
      },
    );
  }
  await assert.rejects(answer("new:越界"), /骨架/);
  const ok = await answer();
  assert.equal(ok.blocks[0].topic_id, b.id);
  assert.deepEqual(ok.blocks[0].source_ids, ["p:book:2:edition2"]);
});
test("不同课次向同一目标续写，每批只发选中证据，引用保留两课定位", async (t) => {
  const { store, course, lesson, note, a } = await setup(t);
  const other = store.createLesson(course.id, "第二课", { noteId: note.id });
  const first = store.addUtterance(lesson.id, "登记窍门");
  const second = store.addUtterance(other.id, "登记示例");
  for (const [l, u] of [
    [lesson, first],
    [other, second],
  ]) {
    const task = store.enqueue(l.id, { uids: [u.id] });
    assert.deepEqual(
      task.input.sources.filter((x) => !x.referenceOnly).map((x) => x.targetId),
      [u.id],
    );
    complete(store, task, a, u.text, [task.input.sources[0].id]);
  }
  assert.match(a.body, /登记窍门/);
  assert.match(a.body, /登记示例/);
  assert.deepEqual(
    a.sources.map((s) => s.lessonId),
    [lesson.id, other.id],
  );
});

test("混合批次只引用第一页后，第二页可独立再次补充", async (t) => {
  const { store, submit, a } = await setup(t);
  const task = submit({
    materials: [{ id: "book", role: "book", from: 1, to: 2 }],
  });
  complete(store, task, a, "只采纳第一页", [task.input.sources[0].id]);
  const next = submit({
    materials: [{ id: "book", role: "book", from: 2, to: 3 }],
  });
  assert.deepEqual(
    next.input.sources.map((p) => p.page),
    [2, 3],
  );
});
test("生成中改骨架后，SQLite 持久任务正确结束，旧任务重试不会消耗调用", async (t) => {
  const { store, submit, note, b } = await setup(t);
  const task = submit({
    materials: [{ id: "book", role: "book", from: 2, to: 2 }],
  });
  const q = new Scheduler(
    store,
    () => "fixture",
    async (_cfg, _key, input) => {
      store.tx(() => note.outline.version++);
      return {
        schema_version: "1",
        blocks: [
          {
            topic_id: b.id,
            title: b.title,
            content_md: "不应写入",
            source_ids: [input.sources[0].id],
            evidence_type: "inference",
          },
        ],
      };
    },
  );
  t.after(() => q.close());
  await q.run(task);
  const current = store.s.tasks.find((x) => x.id === task.id);
  assert.equal(current.state, "failed");
  assert.match(current.error, /骨架/);
  const reopened = await Store.open(store.root);
  try {
    assert.equal(
      reopened.s.tasks.find((t) => t.id === task.id).state,
      "failed",
    );
  } finally {
    reopened.db.close();
  }
  assert.throws(() => q.retry(task.id), /骨架/);
});
test("拒绝的同批补充允许重新生成，重新指定已补过的小节也不会重复落笔", async (t) => {
  const { store, submit, a } = await setup(t);
  store.saveNote(a.id, 0, "原文");
  const materials = [{ id: "book", role: "book", from: 1, to: 1 }];
  const first = submit({ materials });
  complete(store, first, a, "第一次建议", [first.input.sources[0].id]);
  store.candidate(store.s.candidates[0].id, false);
  const retry = submit({ materials });
  assert.notEqual(retry.id, first.id);
  complete(store, retry, a, "新版建议", [retry.input.sources[0].id]);
  store.candidate(store.s.candidates.at(-1).id, true, a.version);
  const manual = submit({ materials, targetId: a.id });
  complete(store, manual, a, "同义再写一遍", [manual.input.sources[0].id]);
  assert.doesNotMatch(a.body, /同义再写一遍/);
  assert.equal(
    store.s.candidates.filter((c) => c.status === "pending").length,
    0,
  );
});
test("跨笔记选用的历史转录不占用原课堂的进度与旧版整理", async (t) => {
  const { store, lesson, note, a, course, submit } = await setup(t);
  const original = store.createLesson(course.id, "尚未关联的历史课堂");
  const u = store.addUtterance(original.id, "登记示例", {
    startMs: 1000,
    endMs: 3000,
  });
  const task = submit({ lessonId: original.id, uids: [u.id], targetId: a.id });
  complete(store, task, a, "历史示例", [task.input.sources[0].id]);
  assert.equal(original.submittedMs, 0);
  const old = store.enqueue(original.id, { uids: [u.id] });
  assert.equal(old.input.noteId, original.noteId);
  assert.notEqual(old.input.noteId, note.id);
});
