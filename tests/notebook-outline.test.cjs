const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../electron/core.cjs");
const { Scheduler, generate } = require("../electron/provider.cjs");
const { routes } = require("../electron/study-routes.cjs");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chapter-outline-"));
  const store = await Store.open(directory);
  t.after(() => {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const course = store.createCourse("课程");
  const notebook = store.newNotebook(course.id, "共享笔记");
  const material = {
    id: "book-one",
    courseId: course.id,
    name: "课程教材.pdf",
    kind: "book",
    sha: "edition-a",
    pages: [
      "范围外前言",
      "第六章 需求工程\n6.1 需求获取\n获取利益相关者的需求。",
      "6.1 需求获取\n6.1.1 访谈\n可以借助开放式问题进行访谈。",
      "6.2 需求验证\n通过评审进行验证。",
      "6.2 需求验证\n补充示例。",
      "范围外下一章",
    ],
  };
  store.s.materials.push(material);
  const api = routes(() => ({ store }));
  const scope = {
    courseId: course.id,
    noteId: notebook.id,
    materialId: material.id,
    role: "book",
    from: 2,
    to: 5,
  };
  const draft = (changes = {}) =>
    api["notebook.outlineDraft"]({ ...scope, ...changes });
  const apply = (task, sections = task.result.sections, changes = {}) =>
    api["notebook.outlineApply"]({
      courseId: course.id,
      noteId: notebook.id,
      taskId: task.id,
      sections,
      ...changes,
    });
  return { api, store, course, notebook, material, draft, apply };
}

test("无转录的教材章节按实际页提取层级，确认前不创建笔记主题", async (t) => {
  const { store, notebook, material, draft, apply } = await fixture(t);
  const task = draft();
  assert.equal(task.state, "succeeded");
  assert.equal(task.type, "outline");
  assert.equal(task.noteId, notebook.id);
  assert.deepEqual(task.primary, {
    materialId: material.id,
    role: "book",
    from: 2,
    to: 5,
  });
  assert.equal(task.input, undefined);
  assert.equal(task.result.method, "local");
  const rows = task.result.sections;
  assert.deepEqual(
    rows.map((r) => [r.title, r.from, r.to]),
    [
      ["第六章 需求工程", 2, 5],
      ["6.1 需求获取", 2, 3],
      ["6.1.1 访谈", 3, 3],
      ["6.2 需求验证", 4, 5],
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.parentKey),
    [null, rows[0].key, rows[1].key, rows[0].key],
  );
  assert.deepEqual(store.s.topics, []);
  assert.equal(notebook.outline, undefined);
  const edited = [
    rows[0],
    { ...rows[3], title: "先讲需求验证" },
    rows[1],
    rows[2],
  ];
  const binding = apply(task, edited);
  const topics = store.s.topics.filter((topic) => topic.noteId === notebook.id);
  assert.deepEqual(
    binding.topicIds,
    topics.map((topic) => topic.id),
  );
  assert.deepEqual(
    topics.map((topic) => topic.parentId),
    [null, topics[0].id, topics[0].id, topics[2].id],
  );
  assert.equal(topics[1].title, "先讲需求验证");
  assert.equal(topics[1].outlineRange.materialId, material.id);
  assert.equal(topics[1].outlineRange.from, 4);
  assert.equal(topics[1].outlineRange.to, 5);
  assert.ok(topics.every((topic) => !topic.body && !topic.sources.length));
  assert.deepEqual(apply(task, edited), binding);
  assert.equal(store.snapshot().tasks[0].appliedVersion, 1);
});

test("课件续页和编辑好的资料目录归并选中范围，相邻资料不会混入", async (t) => {
  const { store, material, draft } = await fixture(t);
  store.s.config.mode = "mock";
  material.kind = "slides";
  material.pages = [
    "范围外",
    "需求获取（1）\n访谈客户",
    "需求获取（续）\n继续访谈",
    "需求验证\n评审需求",
    "需求验证\n案例",
  ];
  const rows = draft({ role: "slides" }).result.sections;
  assert.deepEqual(
    rows.map((row) => [row.title, row.from, row.to]),
    [
      ["需求获取", 2, 3],
      ["需求验证", 4, 5],
    ],
  );
  material.outline = [
    { id: "past", title: "范围外", parentId: null, from: 1, to: 1 },
    { id: "c", title: "访谈与观察", parentId: "p", from: 2, to: 3 },
    { id: "p", title: "需求分析的方法", parentId: null, from: 1, to: 5 },
  ];
  const curated = draft({ role: "book" }).result.sections;
  assert.deepEqual(
    curated.map((r) => [r.title, r.from, r.to]),
    [
      ["需求分析的方法", 2, 5],
      ["访谈与观察", 2, 3],
    ],
  );
  assert.equal(curated[1].parentKey, curated[0].key);
  assert.equal(store.s.tasks.length, 2);
  assert.equal(store.s.topics.length, 0);
});

test("重复生成沿用已确认主题的 ID 与人工正文，过时预览不能覆盖新版本", async (t) => {
  const { api, store, notebook, draft, apply } = await fixture(t);
  const manual = api["note.create"]({ noteId: notebook.id, title: "课堂札记" });
  store.saveNote(manual.id, 0, "我自己的笔记");
  const first = draft(),
    late = draft();
  const old = apply(first);
  const leaf = old.topicIds[2];
  store.saveNote(leaf, 0, "访谈练习以及手工批注");
  assert.throws(() => apply(late), /变化|过期/);
  const next = draft();
  const regenerated = apply(next);
  assert.deepEqual(regenerated.topicIds, old.topicIds);
  assert.equal(regenerated.version, 2);
  assert.throws(() => apply(first), /变化|过期/);
  assert.equal(
    store.s.topics.find((topic) => topic.id === leaf).body,
    "访谈练习以及手工批注",
  );
  assert.equal(
    store.s.topics.find((topic) => topic.id === manual.id).body,
    "我自己的笔记",
  );
  const stale = draft();
  api["topic.structure"]({
    id: leaf,
    noteId: notebook.id,
    parentId: old.topicIds[1],
    title: "访谈提纲",
  });
  assert.equal(notebook.outline.version, 3);
  assert.throws(() => apply(stale), /变化|过期/);
});

test("多合一幻灯片按实际讲授定位重复提纲，只在各节首次展开时建标题", async (t) => {
  const { material, draft } = await fixture(t);
  const agenda = "第 3 章：提纲\n3.1 什么是信号？\n3.2 频谱表示\n3.3 采样定理";
  material.pages = [
    "第 3 章\n信号的表示\n" +
      agenda +
      "\n什么是信号：从物理量看\n信号记录物理量的变化。",
    "信号的例子\n" + agenda + "\n频谱表示\n正弦波的频谱表示。",
    "谱分析\n练习：绘出频谱。\n" + agenda,
    "采样定理\n采样频率的选择。",
  ];
  const rows = draft({ role: "slides", from: 1, to: 4 }).result.sections;
  assert.deepEqual(
    rows.map(({ title, from, to }) => [title, from, to]),
    [
      ["第 3 章 信号的表示", 1, 4],
      ["3.1 什么是信号?", 1, 2],
      ["3.2 频谱表示", 2, 3],
      ["3.3 采样定理", 4, 4],
    ],
  );
  assert.deepEqual(
    rows.slice(1).map((r) => r.parentKey),
    Array(3).fill(rows[0].key),
  );
});

test("英文教材保留问句和跨行标题，滤去跑眉、数字量及正文中的章号", async (t) => {
  const { material, draft } = await fixture(t);
  material.pages = [
    "A chapter introduction ends here.\n4 CHAPTER\nOptical\nSignals and\nthe Spectrum\n1",
    "2 CHAPTER 4 • OPTICAL SIGNALS\n4.1 What Is a Signal?\nThis chapter examines an optical signal.\n4.1.1 Light Sources\nAn LED emits light.",
    "4.1 • WHAT IS A SIGNAL? 3\nSee also\nChapter 9.\n51.8 MHz to 90 MHz\n1.245 ms\n127.2.1.8 . Another address.\n4.1.2 A History of Light:\n1970–1985\nThis period introduced new devices.",
    "4 CHAPTER 4 • OPTICAL SIGNALS\n4.2 Noise and\nInterference\nNoise may impair measurement.",
    "4.2 • NOISE AND INTERFERENCE 5\n4.2.1 Measuring Noise\nThe detector produces a reading.",
  ];
  const rows = draft({ from: 1, to: 5 }).result.sections;
  assert.deepEqual(
    rows.map((r) => r.title),
    [
      "Chapter 4 Optical Signals and the Spectrum",
      "4.1 What Is a Signal?",
      "4.1.1 Light Sources",
      "4.1.2 A History of Light: 1970–1985",
      "4.2 Noise and Interference",
      "4.2.1 Measuring Noise",
    ],
  );
  assert.equal(rows[1].from, 2);
  assert.equal(rows[4].parentKey, rows[0].key);
});

test("首次建立大纲复用原笔记同层唯一同名主题，避免将重名的手写笔记归错节", async (t) => {
  const { api, store, notebook, draft, apply } = await fixture(t);
  const add = (title, parentId) => {
    const topic = api["note.create"]({ noteId: notebook.id, title });
    if (parentId)
      api["topic.structure"]({
        id: topic.id,
        noteId: notebook.id,
        title,
        parentId,
      });
    return topic;
  };
  const root = add("第六章 需求工程");
  const prior = add("6.1 需求获取", root.id);
  const other = add("其他资料");
  const collision = add("6.1 需求获取", other.id);
  store.saveNote(prior.id, 0, "亲自记录的例子");
  const binding = apply(draft());
  assert.deepEqual(binding.topicIds.slice(0, 2), [root.id, prior.id]);
  assert.equal(prior.version, 1);
  assert.equal(prior.body, "亲自记录的例子");
  assert.equal(collision.parentId, other.id);
  assert.ok(!binding.topicIds.includes(collision.id));
});

test("无编号课件用节首页归并后续例题和说明", async (t) => {
  const { material, draft } = await fixture(t);
  material.pages = [
    "访谈方法",
    "开放式问题\n请写出一个例子。",
    "记录与编码\n把回答归类。",
    "观察方法",
    "任务分解\n记录过程。",
    "实地练习\n观察用户。",
  ];
  assert.deepEqual(
    draft({ role: "slides", from: 1, to: 6 }).result.sections.map((r) => [
      r.title,
      r.from,
      r.to,
    ]),
    [
      ["访谈方法", 1, 3],
      ["观察方法", 4, 6],
    ],
  );
});

test("拒绝跨课程、替换来源、循环层级和越界页，同一物理页允许多个小节", async (t) => {
  const { store, notebook, material, draft, apply } = await fixture(t);
  const foreign = store.createCourse("另一课程");
  const foreignNote = store.newNotebook(foreign.id, "外部笔记");
  assert.throws(() => draft({ courseId: foreign.id }), /课程|笔记/);
  assert.throws(
    () => draft({ courseId: foreign.id, noteId: foreignNote.id }),
    /课程|材料|资料/,
  );
  for (const changes of [
    { from: 0 },
    { to: 7 },
    { from: 2.5 },
    { role: "transcript" },
  ])
    assert.throws(() => draft(changes));
  const task = draft(),
    rows = task.result.sections;
  assert.throws(
    () => apply(task, rows, { noteId: foreignNote.id }),
    /课程|笔记/,
  );
  for (const edit of [
    [{ ...rows[0], materialId: "other-material" }],
    [{ ...rows[0], from: 1 }],
    [rows[0], { ...rows[1], key: rows[0].key }],
    [rows[0], { ...rows[1], parentKey: rows[1].key }],
    [{ ...rows[0], to: 2 }, rows[1]],
    [rows[0], rows[1], { ...rows[3], parentKey: null }, rows[2]],
    Array.from({ length: 7 }, (_, i) => ({
      key: "depth" + i,
      parentKey: i ? "depth" + (i - 1) : null,
      title: "嵌套" + i,
      from: 2,
      to: 2,
    })),
  ])
    assert.throws(() => apply(task, edit));
  material.pages[1] += "已重新索引";
  assert.throws(() => apply(task), /资料|来源|索引/);
  assert.equal(notebook.outline, undefined);
  assert.equal(store.s.topics.length, 0);
  const replacement = draft();
  const siblings = replacement.result.sections.slice(0, 2);
  const binding = apply(replacement, [
    siblings[0],
    { ...siblings[1], to: 2 },
    { ...siblings[1], key: "other", title: "同页小节", to: 2 },
  ]);
  assert.equal(binding.topicIds.length, 3);
});

test("云端大纲经过课程授权与预算，分批仅发送选定主资料，取消后不能写入迟到结果", async (t) => {
  const { store, course, material, draft, apply } = await fixture(t);
  store.s.config.mode = "http";
  store.s.config.textModel = "fixture";
  store.s.config.textUrl = "https://example.invalid/chat";
  const lesson = store.createLesson(course.id, "无关课堂");
  store.addUtterance(lesson.id, "绝不能发送的转录");
  store.s.materials.push({
    ...material,
    id: "other",
    pages: ["绝不能发送的辅助教材"],
  });
  for (const page of [1, 2, 3, 4])
    material.pages[page] += "\n正文".repeat(3500);
  let requests = 0,
    waiting;
  const scheduler = new Scheduler(
    store,
    () => "fixture",
    (cfg, key, input, signal, preview) =>
      generate(cfg, key, input, signal, preview, async (_, req) => {
        requests++;
        assert.doesNotMatch(req.body, /范围外|绝不能发送|edition-a|book-one/);
        const wire = JSON.parse(req.body);
        assert.match(wire.messages[0].content, /大纲/);
        const evidence = JSON.parse(wire.messages[1].content);
        assert.equal(evidence.requestKey, undefined);
        assert.ok(
          evidence.pages.length &&
            evidence.pages.every((p) => p.page >= 2 && p.page <= 5),
        );
        if (waiting) await waiting;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    sections: [
                      {
                        key: "a",
                        title: "需求工程",
                        parentKey: null,
                        from: evidence.pages[0].page,
                        to: evidence.pages.at(-1).page,
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
  );
  clearInterval(scheduler.timer);
  t.after(() => scheduler.close());
  const publicTask = draft();
  assert.equal(publicTask.state, "queued");
  assert.equal(draft().id, publicTask.id);
  const task = store.s.tasks.find((x) => x.id === publicTask.id);
  await scheduler.run(task);
  assert.equal(task.state, "failed");
  assert.equal(requests, 0);
  course.consent.text = true;
  Object.assign(store.s.config.pricing, {
    inputPerMillion: 1,
    outputPerMillion: 1,
    budget: 0,
  });
  scheduler.retry(task.id);
  await scheduler.run(task);
  assert.equal(task.state, "failed");
  assert.match(task.error, /预算/);
  assert.equal(requests, 0);
  store.s.config.pricing.budget = null;
  scheduler.retry(task.id);
  await scheduler.run(task);
  assert.equal(task.state, "succeeded", task.error);
  assert.ok(requests > 1);
  assert.equal(task.requests, requests);
  assert.equal(task.result.method, "model");
  assert.deepEqual(
    task.result.sections.map((s) => [s.from, s.to]),
    [[2, 5]],
  );
  assert.equal(store.s.topics.length, 0);
  const cancelled = draft();
  const pendingTask = store.s.tasks.find((x) => x.id === cancelled.id);
  let release;
  waiting = new Promise((resolve) => {
    release = resolve;
  });
  const pending = scheduler.run(pendingTask);
  scheduler.cancel(pendingTask.id);
  release();
  await pending;
  assert.equal(pendingTask.state, "cancelled");
  assert.throws(
    () => apply(pendingTask, task.result.sections),
    /完成|取消|预览/,
  );
  assert.equal(store.s.topics.length, 0);
});

test("其他事务回滚后大纲批次检查点仍可重用，范围外的模型结果不进入预览", async (t) => {
  const { store, course, material, draft } = await fixture(t);
  store.s.config.mode = "http";
  course.consent.text = true;
  material.pages = ["甲".repeat(12000), "乙".repeat(12000), "丙".repeat(12000)];
  const taskId = draft({ from: 1, to: 3 }).id;
  const persisted = () => store.s.tasks.find((t) => t.id === taskId);
  let first = true;
  const requests = [];
  const scheduler = new Scheduler(
    store,
    () => "",
    async (_, __, data) => {
      requests.push(data.from);
      if (data.from === 1 && first) {
        assert.throws(() =>
          store.tx(() => {
            throw new Error("unrelated rollback");
          }),
        );
      }
      const outside = data.from === 2 && first;
      return {
        sections: [
          {
            key: "s",
            title: "同一主题",
            parentKey: null,
            from: data.from,
            to: outside ? 9 : data.to,
          },
        ],
      };
    },
  );
  clearInterval(scheduler.timer);
  t.after(() => scheduler.close());
  await scheduler.run(persisted());
  assert.equal(persisted().state, "failed");
  assert.equal(persisted().result, undefined);
  first = false;
  scheduler.retry(taskId);
  await scheduler.run(persisted());
  assert.equal(persisted().state, "succeeded");
  assert.deepEqual(requests, [1, 2, 2, 3]);
  assert.equal(store.s.topics.length, 0);
});

test("末页明确标出的章末小结与续页合为独立标题", async (t) => {
  const { material, draft } = await fixture(t);
  material.pages = [
    "第2章 光学\n2.1 折射",
    "2.2 透镜\n光线与焦点\n本章小结 1\n回顾透镜的成像条件",
    "本章小结 2\n回顾折射",
  ];
  const rows = draft({ role: "slides", from: 1, to: 3 }).result.sections;
  assert.deepEqual(
    rows.map((r) => r.title),
    ["第2章 光学", "2.1 折射", "2.2 透镜", "本章小结"],
  );
  assert.deepEqual([rows.at(-1).from, rows.at(-1).to], [2, 3]);
});
