const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { Store } = require("../electron/core.cjs");
const { Scheduler } = require("../electron/provider.cjs");
const { runLong, splitSources } = require("../electron/long-task.cjs");
const { migrate, readiness } = require("../electron/study.cjs");
const { routes } = require("../electron/study-routes.cjs");
async function fixture(t) {
  fs.mkdirSync(".test-data", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve(".test-data/study-")),
    s = await Store.open(dir);
  t.after(() => {
    s.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const c = s.createCourse("软件工程"),
    l = s.createLesson(c.id, "第一课"),
    topic = s.topic(l.id, "需求");
  s.s.config.mode = "mock";
  s.addUtterance(l.id, "教师强调：需求要可验证。");
  return { s, c, l, topic, dir };
}
function result(input, content = "内容") {
  return {
    schema_version: "1",
    blocks: [
      {
        topic_id: input.topics[0]?.id || "new:需求",
        title: "需求",
        content_md: content,
        source_ids: input.sources.map((x) => x.id),
        evidence_type: "teacher_explanation",
      },
    ],
  };
}
test("自动模式课堂内不调用，结束后缺口阻塞，完整后仅创建一次整课任务", async (t) => {
  const { s, l } = await fixture(t);
  Object.assign(l, {
    mode: "auto",
    autoPending: true,
    recording: "recording",
    captureMs: 90000,
  });
  assert.equal(s.maybeWhole(l.id), null);
  l.recording = "stopped";
  assert.equal(s.maybeWhole(l.id), null);
  s.s.chunks.push({
    lessonId: l.id,
    startMs: 0,
    endMs: 90000,
    transcribed: true,
  });
  assert.equal(s.maybeWhole(l.id), null);
  l.writeComplete = true;
  l.asrFinalized = true;
  const task = s.maybeWhole(l.id);
  assert.ok(task.input.whole);
  assert.equal(s.maybeWhole(l.id), null);
  assert.equal(s.s.tasks.length, 1);
});
test("缺失音频、未定稿与人工待核对均阻塞整课；显式不完整结果标注", async (t) => {
  const { s, l } = await fixture(t);
  Object.assign(l, {
    captureMs: 10000,
    writeComplete: true,
    asrFinalized: true,
  });
  s.s.chunks.push({ lessonId: l.id, startMs: 0, endMs: 10000 });
  s.s.streams.push({
    lessonId: l.id,
    confirmed: [
      { startMs: 0, endMs: 3000 },
      { startMs: 5000, endMs: 10000 },
    ],
  });
  assert.deepEqual(readiness(s, l.id).missing, [
    { startMs: 3000, endMs: 5000 },
  ]);
  assert.throws(() => s.enqueueWhole(l.id), /待补齐/);
  const task = s.enqueueWhole(l.id, { allowIncomplete: true });
  task.state = "running";
  s.applyResult(task.id, result(task.input));
  assert.match(s.s.candidates[0].body, /不完整转录/);
});
test("整课支持大于旧160K限制，单来源自动拆批且保持来源身份", async (t) => {
  const { s, l } = await fixture(t);
  for (let i = 0; i < 5; i++) s.addUtterance(l.id, "长课资料。".repeat(10000));
  const task = s.enqueueWhole(l.id);
  assert.ok(JSON.stringify(task.input).length > 160000);
  const batches = splitSources(task.input.sources);
  assert.ok(batches.length > 10);
  assert.ok(
    batches.every(
      (batch) => batch.reduce((n, x) => n + x.text.length, 0) <= 18000,
    ),
  );
});
test("跨课堂共享笔记保留旧来源与手改；并发版本冲突只产生候选", async (t) => {
  const { s, c, l, topic } = await fixture(t),
    l2 = s.createLesson(c.id, "第二课", { noteId: l.noteId });
  s.addUtterance(l2.id, "纠正：第一课的定义需补充约束。");
  assert.equal(s.lessonTopics(l2.id)[0].id, topic.id);
  const a = s.enqueue(l.id),
    b = s.enqueue(l2.id);
  a.state = "running";
  b.state = "running";
  s.applyResult(a.id, result(a.input, "第一课事实"));
  s.saveNote(topic.id, 1, "第一课事实与人工批注");
  s.applyResult(b.id, result(b.input, "第二课补充"));
  assert.equal(topic.body, "第一课事实与人工批注");
  assert.equal(s.s.candidates.length, 1);
  const originalNote = l.noteId;
  const otherNote = s.newNotebook(c.id, "切换后的笔记");
  s.updateLesson(l.id, { noteId: otherNote.id });
  const frozen = s.freeze(l.id, {
    all: true,
    noteId: originalNote,
    baseline: [structuredClone(topic)],
  });
  assert.equal(frozen.noteId, originalNote);
  assert.equal(frozen.topics[0].id, topic.id);
  assert.throws(() => s.candidate(s.s.candidates[0].id, true, 2), /过期/);
});
test("旧课堂笔记迁移保留ID/内容/历史，重复迁移不复制；删除课堂不删除共享资源", async (t) => {
  const { s, l, topic } = await fixture(t);
  s.saveNote(topic.id, 0, "原文");
  const revision = s.s.revisions[0].id;
  delete topic.courseId;
  delete topic.noteId;
  delete l.noteId;
  s.s.notebooks = [];
  s.s.schema = 1;
  migrate(s.s);
  migrate(s.s);
  assert.equal(s.s.notebooks.length, 1);
  assert.equal(s.s.revisions[0].id, revision);
  assert.equal(topic.body, "原文");
  s.deleteLesson(l.id);
  assert.equal(s.s.notebooks.length, 1);
  assert.equal(s.s.topics.length, 1);
  s.saveNote(topic.id, 1, "删除课堂后仍可编辑共享笔记");
});
test("多对话隔离历史/草稿/来源，跨课程来源被拒绝，课程学习无需课堂", async (t) => {
  const { s, c, topic } = await fixture(t),
    other = s.createCourse("另一门课");
  const material = {
    id: "m",
    courseId: c.id,
    name: "课件",
    sha: "v1",
    pages: ["需求必须可验证"],
  };
  s.s.materials.push(material);
  const a = s.conversation({
      courseId: c.id,
      name: "预习",
      draft: "草稿A",
      scope: { materials: [{ id: "m", from: 1, to: 1 }] },
    }),
    b = s.conversation({ courseId: c.id, name: "复习", draft: "草稿B" });
  const task = s.enqueueStudy({
    courseId: c.id,
    conversationId: a.id,
    kind: "chat",
    prompt: "什么是需求？",
  });
  task.state = "running";
  s.applyStudy(task, result(task.input, "需求要可验证"));
  assert.equal(a.messages.length, 2);
  assert.equal(b.messages.length, 0);
  assert.equal(b.draft, "草稿B");
  assert.equal(task.lessonId, undefined);
  assert.throws(
    () => s.conversation({ courseId: other.id, scope: a.scope }),
    /无效/,
  );
  const next = s.enqueueStudy({
    courseId: c.id,
    conversationId: b.id,
    kind: "chat",
    scope: a.scope,
    prompt: "复习问题",
  });
  assert.deepEqual(next.input.history, []);
});
test("长课分批部分失败后复用持久检查点，最后归并不丢来源", async (t) => {
  const { s, l } = await fixture(t);
  for (let i = 0; i < 3; i++) s.addUtterance(l.id, "源材料".repeat(4000));
  const task = s.enqueueWhole(l.id);
  task.state = "running";
  let count = 0,
    fail = true;
  const invoke = async (input) => {
    count++;
    if (count === 2 && fail) throw new Error("断网");
    return result(input, "归并事实与后续纠正");
  };
  await assert.rejects(
    runLong(s, task, invoke, new AbortController().signal, () => {}),
    /断网/,
  );
  assert.equal(Object.keys(task.checkpoints).length, 1);
  fail = false;
  const before = count,
    output = await runLong(
      s,
      task,
      invoke,
      new AbortController().signal,
      () => {},
    );
  assert.ok(count > before);
  assert.equal(output.blocks.length, 1);
  assert.ok(output.blocks[0].source_ids.length >= 3);
  const completed = count;
  await runLong(s, task, invoke, new AbortController().signal, () => {});
  assert.equal(count, completed);
});
test("课程任务取消后迟到响应不能写入对话", async (t) => {
  const { s, c, l } = await fixture(t);
  const chat = s.conversation({ courseId: c.id, scope: { lessonIds: [l.id] } }),
    task = s.enqueueStudy({
      courseId: c.id,
      conversationId: chat.id,
      kind: "chat",
      prompt: "解释",
    });
  let resolve;
  const scheduler = new Scheduler(
    s,
    () => "",
    async () => new Promise((r) => (resolve = r)),
  );
  clearInterval(scheduler.timer);
  t.after(() => scheduler.close());
  const pending = scheduler.run(task);
  scheduler.cancel(task.id);
  resolve(result(task.input));
  await pending;
  assert.equal(task.state, "cancelled");
  assert.equal(chat.messages.length, 1);
});
test("本地Markdown附件迁移、路径越界/缺失报告、导出相对图片", async (t) => {
  const { s, c, dir } = await fixture(t),
    attachments = require("../electron/attachments.cjs");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  fs.writeFileSync(path.join(dir, "a.png"), png);
  const imported = attachments.migrateMarkdown(
    s,
    c.id,
    path.join(dir, "notes.md"),
    "![图](a.png)\n![丢失](none.png)\n![越界](../out.png)",
  );
  assert.equal(imported.missing.length, 2);
  assert.match(imported.body, /attachment:/);
  const out = path.join(dir, "export"),
    exported = attachments.exportMarkdown(s, imported.body, out);
  assert.match(exported.body, /attachments\//);
  assert.equal(fs.readdirSync(path.join(out, "attachments")).length, 1);
});
test("模板迁移只处理所选主题，确认前不改原文；预览使用代表主题", async (t) => {
  const { s, l, topic } = await fixture(t);
  s.saveNote(topic.id, 0, "主题A");
  const other = s.topic(l.id, "范围外");
  s.saveNote(other.id, 0, "范围外原文");
  const api = routes(() => ({ store: s })),
    task = api["template.migrate"]({ lessonId: l.id, topicIds: [topic.id] });
  assert.equal(task.input.topics.length, 1);
  task.state = "running";
  s.applyResult(task.id, result(task.input, "迁移候选"));
  assert.equal(topic.body, "主题A");
  assert.equal(other.body, "范围外原文");
  assert.equal(s.s.candidates.length, 1);
  const preview = api["template.preview"]({
    lessonId: l.id,
    topicIds: [other.id],
    rules: s.course(l.courseId).template.rules,
  });
  assert.equal(preview.input.topics[0].id, other.id);
});
test("金额预算与次数分离，价格未知阻塞；实际用量回收预留估算", async (t) => {
  const { s, l } = await fixture(t),
    budget = require("../electron/budget.cjs");
  s.s.config.mode = "http";
  const task = s.enqueue(l.id);
  s.s.config.pricing = {
    budget: 1,
    inputPerMillion: null,
    outputPerMillion: null,
  };
  assert.throws(() => budget.reserve(s, task, task.input), /缺少价格/);
  s.s.config.pricing = { budget: 1, inputPerMillion: 1, outputPerMillion: 2 };
  const held = budget.reserve(s, task, task.input);
  budget.account(
    s,
    task,
    { _usage: { prompt_tokens: 100, completion_tokens: 50 } },
    held,
  );
  assert.equal(task.costActual, 0.0002);
  assert.equal(task.costReserved, 0.0002);
  s.s.config.pricing.budget = 0;
  assert.throws(() => budget.reserve(s, task, task.input), /预算/);
});
test("模板编号、重点、列表、来源格式确定呈现，公式不被改写", () => {
  const { format } = require("../electron/presentation.cjs");
  const md = "# 定义\n1. 【教师强调】$x^2$\n\n$$\nE=mc^2\n$$";
  const result = format(
    md,
    {
      heading_numbering: "中文序号",
      list_style: "项目符号",
      source_format: "来源列表",
    },
    [{ name: "教材", page: 5 }],
  );
  assert.match(result, /# 一、定义/);
  assert.match(result, /- \*\*【教师强调】\*\*\$x\^2\$/);
  assert.match(result, /\$\$\nE=mc\^2\n\$\$/);
  assert.equal(
    format(
      result,
      {
        heading_numbering: "中文序号",
        list_style: "项目符号",
        source_format: "来源列表",
      },
      [{ name: "教材", page: 5 }],
    ),
    result,
  );
});
