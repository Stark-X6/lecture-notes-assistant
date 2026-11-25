const { test } = require("node:test"),
  assert = require("node:assert/strict");
const format = require("../electron/presentation.cjs"),
  outline = require("../electron/notebook-outline.cjs");
const { generate } = require("../electron/provider.cjs");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Store } = require("../electron/core.cjs");
const { routes } = require("../electron/study-routes.cjs");

test("手动调整父节后，课程导出按阅读顺序保留层级，正文标题从属于它的小节", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-hierarchy-"));
  const store = await Store.open(dir);
  t.after(() => {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const course = store.createCourse("软件工程");
  const notebook = store.newNotebook(course.id, "复习笔记");
  const api = routes(() => ({
    store,
    dialog: { showOpenDialog: async () => ({ filePaths: [dir] }) },
    shell: { showItemInFolder() {} },
  }));
  const create = (title) => api["note.create"]({ noteId: notebook.id, title });
  const chapter = create("质量保障");
  create("交付");
  const section = create("黑盒测试");
  api["topic.structure"]({
    id: section.id,
    noteId: notebook.id,
    title: section.title,
    parentId: chapter.id,
  });
  const body = "# 边界值\n\n~~~sh\n# 示例注释\n~~~";
  store.saveNote(section.id, 0, body);
  const output = await api["study.export"]({
    courseId: course.id,
    noteId: notebook.id,
  });
  const markdown = fs.readFileSync(
    path.join(output.directory, "notes.md"),
    "utf8",
  );
  assert.deepEqual(markdown.match(/^#+ .+$/gm), [
    "# 复习笔记",
    "## 质量保障",
    "### 黑盒测试",
    "#### 边界值",
    "# 示例注释",
    "## 交付",
  ]);
  assert.equal(
    store.s.topics.find((topic) => topic.id === section.id).body,
    body,
  );
});
test("导出的正文标题保持在骨架小节下，代码和公式原样保留", () => {
  const code = "\n~~~md\n# 原始示例\n~~~\n\n$$\n# 数学文本\n$$";
  const raw = "### 定义\n#### 条件\n### 例子" + code;
  assert.equal(
    format.nestMarkdown(raw, 4),
    "##### 定义\n###### 条件\n##### 例子" + code,
  );
  assert.equal(
    format.nestMarkdown("已经没有标题的说明", 4),
    "已经没有标题的说明",
  );
});
test("模型遗漏主资料末尾明确的小结时，归并保存实页范围，不重复已有收束节点", () => {
  const pages = [
    { page: 1, text: "第二章 光学\n2.1 折射" },
    { page: 2, text: "2.2 透镜\n透镜的成像\n本章小结 1" },
    { page: 3, text: "本章小结 2\n回顾折射和成像" },
  ];
  const rows = [
    { key: "root", title: "第二章 光学", parentKey: null, from: 1, to: 2 },
    { key: "sec", title: "透镜", parentKey: "root", from: 2, to: 2 },
  ];
  const final = outline.completeClosingSection(rows, pages, {
    role: "slides",
    from: 1,
    to: 3,
  });
  assert.equal(final[0].to, 3);
  assert.deepEqual(
    final.slice(-1).map((r) => [r.title, r.from, r.to, r.parentKey]),
    [["本章小结", 2, 3, "root"]],
  );
  assert.deepEqual(
    outline.completeClosingSection(final, pages, {
      role: "slides",
      from: 1,
      to: 3,
    }),
    final,
  );
});
test("真实响应中临时引用换成对应页码与课堂时间，保留技术记号和代码", async () => {
  const input = {
    noteScope: { requiresSlides: true, order: "slides" },
    sources: [
      {
        id: "u:1:1",
        kind: "transcript",
        startMs: 12000,
        endMs: 14000,
        text: "第一句",
      },
      {
        id: "u:2:1",
        kind: "transcript",
        startMs: 14001,
        endMs: 17600,
        text: "第二句",
      },
      {
        id: "page:p:2",
        kind: "material",
        materialRole: "slides",
        page: 2,
        name: "讲义.pdf",
        text: "讲义",
      },
      {
        id: "page:p:3",
        kind: "material",
        materialRole: "slides",
        page: 3,
        name: "讲义.pdf",
        text: "下一节的材料",
      },
    ],
    topics: [],
    context: {},
    template: { rules: {} },
  };
  const value = {
    schema_version: "1",
    blocks: [
      {
        topic_id: "new:例",
        title: "例",
        content_md:
          "依据（S1,T1–T2）。线路 T1、维生素B2。\n\n`(T1,T2)`\n\n来源：S1、T2。",
        source_ids: ["S1", "T1", "T2"],
        evidence_type: "teacher_explanation",
      },
      {
        topic_id: "new:补充",
        title: "补充",
        content_md:
          "已声明的依据（S1）。混合清单（S1、S2）与区间（S1–S2）。\n无声明（S2），未知（S1、S2、S99），表达式（S1+S2），`（S1、S2）`。",
        source_ids: ["S1"],
        evidence_type: "teacher_explanation",
      },
    ],
  };
  const result = await generate(
    {
      mode: "http",
      textUrl: "https://api.deepseek.com/chat/completions",
      textModel: "fixture",
      maxOutput: 3000,
    },
    "fixture",
    input,
    new AbortController().signal,
    () => {},
    async () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(value) },
          },
        ],
      }),
  );
  const b = result.blocks[0];
  assert.match(b.content_md, /课件 PDF 第 2 页/);
  assert.match(b.content_md, /00:12[–—-]00:17/);
  assert.doesNotMatch(b.content_md, /来源：S1/);
  assert.match(b.content_md, /线路 T1、维生素B2/);
  assert.ok(b.content_md.includes("`(T1,T2)`"));
  assert.deepEqual(b.source_ids, ["page:p:2", "u:1:1", "u:2:1"]);
  const partial = result.blocks[1];
  assert.deepEqual(partial.source_ids, ["page:p:2"]);
  assert.equal(
    partial.content_md,
    "已声明的依据（课件 PDF 第 2 页）。混合清单（部分引用待核对，见本节来源）与区间（部分引用待核对，见本节来源）。\n无声明（S2），未知（S1、S2、S99），表达式（S1+S2），`（S1、S2）`。",
  );
});
