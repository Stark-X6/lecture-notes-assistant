const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const initSql = require("sql.js");
const { MAX_NOTE_CHARS } = require("./generation-limits.cjs");
const id = () => randomUUID();
const hash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const clone = (x) => structuredClone(x);
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
const check = (v, message = "输入无效") => {
  if (!v) fail("INVALID_INPUT", message);
};
const text = (v, max = 100000) => {
  check(typeof v === "string" && v.length <= max);
  return v;
};
const DEFAULT_TEMPLATE = {
  heading_numbering: "层级编号",
  detail_level: "标准",
  list_style: "项目符号",
  emphasis_style: "加粗标签",
  source_format: "来源列表",
  image_policy: "保留原图",
  custom_prompt:
    "保留定义、条件、例子和推导。分别标记【教师强调】【推断重点】【考试要求】【待核实】。",
};
function initial() {
  return {
    schema: 1,
    courses: [],
    lessons: [],
    materials: [],
    utterances: [],
    topics: [],
    revisions: [],
    candidates: [],
    tasks: [],
    chunks: [],
    streams: [],
    events: [],
    config: {
      mode: "off",
      asrBackend: "local",
      textUrl: "https://api.openai.com/v1/chat/completions",
      textModel: "",
      textThinking: false,
      asrUrl: "wss://api.openai.com/v1/realtime?intent=transcription",
      asrModel: "gpt-live-transcribe",
      asrProvider: "openai",
      tingwuAppKey: "",
      tingwuLanguage: "cn",
      fileUrl: "https://api.openai.com/v1/audio/transcriptions",
      fileModel: "",
      version: 1,
      maxCalls: 100,
      maxOutput: 3000,
      policy: "请查阅所选供应商的数据保留政策",
    },
    secrets: {},
  };
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
class Store {
  static async open(root) {
    const SQL = await initSql();
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, "app.db");
    const db = fs.existsSync(file)
      ? new SQL.Database(fs.readFileSync(file))
      : new SQL.Database();
    db.run(
      "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (version INTEGER NOT NULL);",
    );
    const row = db.exec("SELECT body FROM state WHERE id=1");
    if (
      row.length &&
      (JSON.parse(row[0].values[0][0]).schema || 1) < 3 &&
      !fs.existsSync(path.join(root, "app.pre-v03.db"))
    )
      fs.copyFileSync(file, path.join(root, "app.pre-v03.db"));
    const self = new Store(
      root,
      db,
      row.length ? JSON.parse(row[0].values[0][0]) : initial(),
    );
    self.save();
    return self;
  }
  constructor(root, db, state) {
    this.root = root;
    this.db = db;
    this.s = state;
    // Merge fields introduced by newer backends. New installations retain
    // local ASR as the safe default; databases created by the older cloud
    // branch (which had no asrBackend field) keep their HTTP cloud behavior.
    const hadAsrBackend = Object.hasOwn(state.config || {}, "asrBackend");
    this.s.config = { ...initial().config, ...state.config };
    if (!hadAsrBackend) this.s.config.asrBackend = "cloud";
    require("./study.cjs").migrate(this.s);
    this.onChange = () => {};
  }
  save() {
    this.db.run("INSERT OR REPLACE INTO state VALUES (1,?)", [
      JSON.stringify(this.s),
    ]);
    atomicWrite(path.join(this.root, "app.db"), Buffer.from(this.db.export()));
  }
  tx(fn) {
    const old = clone(this.s);
    try {
      const out = fn(this.s);
      this.save();
      this.onChange();
      return out;
    } catch (e) {
      this.s = old;
      this.db.run("INSERT OR REPLACE INTO state VALUES (1,?)", [
        JSON.stringify(old),
      ]);
      throw e;
    }
  }
  snapshot() {
    const s = clone(this.s);
    delete s.secrets;
    s.config.hasTextKey = !!this.s.secrets.text;
    s.config.hasAsrKey = !!this.s.secrets.asr;
    s.config.hasDeepseekAsrKey = !!this.s.secrets.deepseekAsrKey;
    s.config.hasTingwuId = !!this.s.secrets.tingwuId;
    s.config.hasTingwuSecret = !!this.s.secrets.tingwuSecret;
    s.config.pendingTingwuTasks = s.streams.filter(
      (x) =>
        x.provider === "tingwu" &&
        x.cloudTaskId &&
        !["stopped", "failed"].includes(x.cloudState),
    ).length;
    for (const m of s.materials) delete m.path;
    for (const c of s.chunks) delete c.path;
    for (const l of s.lessons) l.readiness = this.readiness(l.id);
    for (const a of s.attachments) delete a.path;
    for (const t of s.tasks) delete t.input;
    return s;
  }
  course(cid) {
    return (
      this.s.courses.find((c) => c.id === cid && !c.deleted) ||
      fail("NOT_FOUND", "课程不存在")
    );
  }
  lesson(lid) {
    const l = this.s.lessons.find((l) => l.id === lid);
    if (!l) fail("NOT_FOUND", "课次不存在");
    this.course(l.courseId);
    return l;
  }
  event(lid, type, payload) {
    this.s.events.push({
      id: id(),
      lessonId: lid,
      type,
      payload,
      at: Date.now(),
    });
    if (this.s.events.length > 3000) this.s.events.splice(0, 1000);
  }
  createCourse(name) {
    check(text(name, 120).trim(), "请输入课程名称");
    return this.tx((s) => {
      const c = {
        id: id(),
        name: name.trim(),
        createdAt: Date.now(),
        template: { id: id(), version: 1, rules: clone(DEFAULT_TEMPLATE) },
        consent: { text: false, audio: false, version: s.config.version },
      };
      s.courses.push(c);
      return c;
    });
  }
  createLesson(cid, name, options = {}) {
    this.course(cid);
    return this.tx((s) => {
      const l = {
        id: id(),
        courseId: cid,
        name: text(name, 120) || "新课次",
        mode: "semi",
        recording: "stopped",
        captureMs: 0,
        submittedMs: 0,
        windows: [],
        aiPaused: false,
        createdAt: Date.now(),
        context: {},
        calls: 0,
      };
      l.startedAt = Number.isFinite(options.startedAt)
        ? options.startedAt
        : l.createdAt;
      l.autoAfterStop = true;
      if (options.noteId)
        check(
          s.notebooks.some(
            (n) => n.id === options.noteId && n.courseId === cid,
          ),
          "目标笔记不属于本课程",
        );
      l.noteId = options.noteId || id();
      if (!options.noteId)
        s.notebooks.push({
          id: l.noteId,
          courseId: cid,
          name: l.name + "笔记",
          createdAt: Date.now(),
        });
      s.lessons.push(l);
      return l;
    });
  }
  topic(lid, title) {
    this.lesson(lid);
    return this.tx((s) => {
      const t = {
        id: id(),
        lessonId: lid,
        courseId: this.lesson(lid).courseId,
        noteId: this.lesson(lid).noteId,
        parentId: null,
        title: text(title, 120) || "待归类",
        version: 0,
        body: "",
        human: false,
        sources: [],
        stale: false,
      };
      s.topics.push(t);
      return t;
    });
  }
  saveNote(tid, version, body, human = true, sources) {
    const t = this.s.topics.find((x) => x.id === tid);
    check(t, "主题不存在");
    this.course(t.courseId);
    if (t.version !== version)
      fail("VERSION_CONFLICT", "笔记已变化，请重新加载后保存");
    text(body, MAX_NOTE_CHARS);
    return this.tx((s) => {
      s.revisions.push({
        id: id(),
        topicId: tid,
        version: t.version,
        body: t.body,
        human: t.human,
        sources: clone(t.sources),
        createdAt: Date.now(),
      });
      t.body = body;
      t.version++;
      t.human = human;
      t.sources = sources ?? t.sources;
      t.stale = false;
      return t;
    });
  }
  restore(rid, version) {
    const r = this.s.revisions.find((x) => x.id === rid);
    check(r, "历史版本不存在");
    return this.saveNote(r.topicId, version, r.body, true, clone(r.sources));
  }
  addUtterance(lid, body, timing = {}) {
    this.lesson(lid);
    check(text(body).trim());
    return this.tx((s) => {
      const u = {
        id: id(),
        lessonId: lid,
        text: body,
        revision: 1,
        history: [],
        startMs: null,
        endMs: null,
        topicId: null,
        final: true,
        createdAt: Date.now(),
        ...timing,
      };
      s.utterances.push(u);
      return u;
    });
  }
  revise(uid, revision, body) {
    const u = this.s.utterances.find((x) => x.id === uid);
    check(u);
    this.lesson(u.lessonId);
    if (u.revision !== revision) fail("VERSION_CONFLICT", "转录已被修改");
    return this.tx((s) => {
      u.history.push({ revision: u.revision, text: u.text });
      u.text = text(body);
      u.revision++;
      // Manual correction clears the local-ASR quality review marker while
      // retaining the original transcript in history for auditability.
      u.needsReview = false;
      u.reviewReason = null;
      for (const t of s.topics.filter((t) =>
        t.sources.some((r) => r.targetId === uid),
      ))
        t.stale = true;
    });
  }
  assign(lid, uids, tid) {
    this.lesson(lid);
    const t = this.s.topics.find(
      (t) => t.id === tid && t.noteId === this.lesson(lid).noteId,
    );
    check(t, "请选择本课主题");
    const us = this.s.utterances.filter((u) => uids.includes(u.id));
    check(us.length && us.every((u) => u.lessonId === lid), "内容不属于本课");
    return this.tx((s) => {
      for (const u of us) {
        u.topicId = tid;
        u.revision++;
      }
      this.event(lid, "topic.assignment", { uids, tid });
    });
  }
  setContext(lid, context) {
    const l = this.lesson(lid);
    const next = clone(context);
    for (const key of ["slides", "book"]) {
      if (!next[key]) continue;
      const m = this.s.materials.find(
        (m) => m.id === next[key].id && m.courseId === l.courseId,
      );
      check(m, "材料不属于本课程");
      if (key === "book") next.book = { id: m.id };
      else
        check(
          Number.isInteger(next.slides.from) &&
            Number.isInteger(next.slides.to) &&
            next.slides.from >= 1 &&
            next.slides.to >= next.slides.from &&
            next.slides.to <= m.pages.length,
          "课件页码范围无效",
        );
    }
    if (next.outlineSource)
      check(
        ["slides", "book", "transcript"].includes(next.outlineSource),
        "笔记结构来源无效",
      );
    if (context.topicId)
      check(
        this.s.topics.some(
          (t) => t.id === context.topicId && t.noteId === l.noteId,
        ),
      );
    return this.tx(() => {
      l.context = next;
      this.event(lid, "page.context", {
        captureMs: l.captureMs,
        context: next,
      });
    });
  }
  freeze(lid, opts = {}) {
    const l = this.lesson(lid),
      c = this.course(l.courseId);
    const noteId = opts.noteId || l.noteId;
    check(
      this.s.notebooks.some(
        (n) => n.id === noteId && n.courseId === l.courseId,
      ),
      "目标笔记不属于本课程",
    );
    const all = opts.all || opts.preview;
    const context = opts.context || l.context;
    if (!opts.preview && this.s.notebooks.find((n) => n.id === noteId)?.outline)
      return require("./chapter-supplement.cjs").prepare(
        this,
        { ...opts, courseId: l.courseId, noteId, lessonId: lid },
        true,
      );
    let us = this.s.utterances.filter(
      (u) =>
        u.lessonId === lid &&
        u.final &&
        (all ||
          !this.s.tasks.some(
            (t) =>
              ["queued", "running", "succeeded"].includes(t.state) &&
              t.type === "notes" &&
              (!t.input?.noteId || t.input.noteId === noteId) &&
              t.input?.utterances.some(
                (x) => x.id === u.id && x.revision === u.revision,
              ),
          )),
    );
    check(us.length, "没有新的定稿内容；可用“整课整理”重新生成");
    if (opts.uids) us = us.filter((u) => opts.uids.includes(u.id));
    check(us.length, "选定范围没有内容");
    const scope = require("./note-scope.cjs");
    const refs = scope.transcriptRefs(this.s.utterances, l, us);
    const material = (selection) =>
      selection &&
      this.s.materials.find(
        (m) => m.id === selection.id && m.courseId === l.courseId,
      );
    const slides = material(context.slides);
    const selectedBook = material(context.book);
    const book = selectedBook?.id === slides?.id ? undefined : selectedBook;
    const order =
      context.outlineSource === "book" && book
        ? "book"
        : slides
          ? "slides"
          : "transcript";
    const noteScope =
      slides || order === "book"
        ? { order, requiresSlides: !!slides, version: 2 }
        : undefined;
    const slidePages = slides
      ? scope
          .pageRefs(slides, "slides", context.slides.from, context.slides.to)
          .filter((p) => p.text.trim())
      : [];
    if (slides)
      check(slidePages.length, "所选课件页没有可提取文字，请调整课件范围");
    const bookPages = book
      ? scope.textbookPages(
          scope.pageRefs(book, "book"),
          slidePages.length
            ? slidePages.map((p) => p.text)
            : us.map((u) => u.text),
        )
      : [];
    if (order === "book")
      check(
        bookPages.length,
        "未在教材中找到相关页面，请检查教材，或改用课件／课堂讲解结构",
      );
    refs.push(...slidePages, ...bookPages);
    const topics = this.s.topics
      .filter(
        (t) =>
          t.noteId === noteId &&
          t.courseId === l.courseId &&
          (!opts.topicIds || opts.topicIds.includes(t.id)),
      )
      .map((t) => ({
        id: t.id,
        title: t.title,
        body: t.body,
        version: t.version,
        human: t.human,
        sources: clone(t.sources),
      }));
    if (opts.baseline) topics.splice(0, topics.length, ...clone(opts.baseline));
    // Scoped requests use old headings as writing targets, and merge locally.
    for (const topic of topics) {
      if (noteScope) {
        topic.body = "";
        topic.sources = [];
        continue;
      }
      for (const source of topic.sources) {
        if (
          source.kind === "transcript" &&
          !refs.some((r) => r.id === source.id)
        )
          refs.push(clone(source));
      }
      topic.sources = topic.sources.filter((source) =>
        refs.some((r) => r.id === source.id),
      );
    }
    const input = {
      lessonId: lid,
      courseId: l.courseId,
      noteId,
      incomplete: opts.incomplete || null,
      whole: !!opts.all,
      utterances: noteScope
        ? us.map((u) => ({ ...u, history: [] }))
        : clone(us),
      sources: refs,
      topics,
      context: clone(context),
      prompt: text(opts.prompt || "", 4000),
      template: clone(opts.template || c.template),
      provider: clone(this.s.config),
      forceCandidate: !!opts.all,
      noteScope,
      structure:
        order === "slides"
          ? scope.outlineForPages(
              slides,
              slidePages.map((p) => p.page),
            )
          : scope.outlineForPages(
              book,
              bookPages.map((p) => p.page),
            ),
    };
    check(
      opts.all || opts.preview || JSON.stringify(input).length < 160000,
      "本段超过上下文限制，请选择较小范围提交",
    );
    return input;
  }
  enqueue(lid, opts = {}) {
    const lesson = this.lesson(lid);
    const noteId = opts.noteId || lesson.noteId;
    if (!opts.preview && this.s.notebooks.find((n) => n.id === noteId)?.outline)
      return require("./chapter-supplement.cjs").enqueue(
        this,
        { ...opts, courseId: lesson.courseId, noteId, lessonId: lid },
        true,
      );
    if (opts.outlineStamp)
      fail("OUTLINE_CHANGED", "章节骨架已变更，请重新提交本段");
    let input;
    try {
      input = this.freeze(lid, opts);
    } catch (e) {
      if (e.message.startsWith("没有新的") && !opts.all && !opts.preview) {
        const l = this.lesson(lid),
          c = this.course(l.courseId);
        const active = [...this.s.tasks]
          .reverse()
          .find(
            (t) =>
              t.lessonId === lid &&
              t.type === "notes" &&
              (!t.input?.noteId || t.input.noteId === noteId) &&
              ["queued", "running"].includes(t.state) &&
              t.input.prompt === (opts.prompt || "") &&
              hash(t.input.context) === hash(l.context) &&
              t.input.template.version === c.template.version &&
              t.input.provider.version === this.s.config.version &&
              t.input.topics.every(
                (t) =>
                  this.s.topics.find((x) => x.id === t.id)?.version ===
                  t.version,
              ) &&
              t.input.utterances.every(
                (u) =>
                  this.s.utterances.find((x) => x.id === u.id)?.revision ===
                  u.revision,
              ),
          );
        if (active) return active;
      }
      throw e;
    }
    const type = opts.preview ? "preview" : "notes";
    const key = hash({ type, input });
    const prev = this.s.tasks.find(
      (t) => t.key === key && t.state !== "cancelled",
    );
    if (prev) return prev;
    const supersedes = [...this.s.tasks]
      .reverse()
      .find(
        (t) =>
          t.lessonId === lid &&
          t.type === type &&
          hash(t.input.utterances?.map((u) => u.id)) ===
            hash(input.utterances.map((u) => u.id)),
      )?.id;
    return this.tx((s) => {
      const t = {
        id: id(),
        lessonId: lid,
        type,
        key,
        input,
        supersedes,
        state: "queued",
        lane: opts.all || opts.preview ? "background" : "live",
        createdAt: opts.submittedAt || Date.now(),
        attempt: 0,
        preview: "",
        firstContentMs: null,
        error: null,
        usage: null,
      };
      s.tasks.push(t);
      this.event(lid, "submission.created", {
        taskId: t.id,
        sourceIds: input.sources.map((s) => s.id),
      });
      return t;
    });
  }
  applyResult(taskId, result) {
    const task = this.s.tasks.find((t) => t.id === taskId);
    check(task && task.state === "running", "任务已取消");
    if (task.lessonId) this.lesson(task.lessonId);
    else this.course(task.input.courseId);
    validateResult(result, task.input);
    return this.tx((s) => {
      if (task.type === "preview") {
        for (const b of result.blocks)
          b.content_md = require("./presentation.cjs").format(
            b.content_md,
            task.input.template.rules,
            b.source_ids.map((id) =>
              task.input.sources.find((s) => s.id === id),
            ),
          );
        task.result = result;
        task.state = "succeeded";
        task.finishedAt = Date.now();
        return;
      }
      if (task.input.chapterOutline)
        return require("./chapter-supplement.cjs").apply(this, s, task, result);
      if (!task.input.migration)
        check(
          !s.notebooks.find((n) => n.id === task.input.noteId)?.outline,
          "目标笔记已启用章节骨架，请按当前骨架重新提交",
        );
      const noteScope = task.input.noteScope;
      const review = require("./lecture-evidence.cjs");
      const opening = review.introduction(task.input);
      const position = (block) =>
        require("./note-scope.cjs").position(block, task.input);
      const blocks = noteScope
        ? [...result.blocks].sort((a, b) => {
            const first = position(a),
              second = position(b);
            return (
              Number(first.fallback) - Number(second.fallback) ||
              first.page - second.page
            );
          })
        : result.blocks;
      for (const b of blocks) {
        let topic = s.topics.find(
          (t) =>
            t.noteId === task.input.noteId &&
            (t.id === b.topic_id ||
              (b.topic_id.startsWith("new:") && t.title === b.title)),
        );
        const baseline = task.input.topics.find(
          (t) => t.id === (topic?.id || b.topic_id),
        );
        let sources = b.source_ids.map((r) =>
          clone(task.input.sources.find((s) => s.id === r)),
        );
        if (task.input.migration)
          check(
            task.input.topics.some((t) => t.id === b.topic_id),
            "模板迁移不得新增范围外主题",
          );
        const stale = task.input.utterances.some(
          (u) =>
            s.utterances.find((x) => x.id === u.id)?.revision !== u.revision,
        );
        if (noteScope)
          b.content_md = review.qualifyEmphasis(b.content_md, sources);
        if (review.isIntroductory(opening, b.title, sources)) {
          task.introduction ||= [];
          task.introduction.push({
            title: b.title,
            body: require("./presentation.cjs").format(
              b.content_md,
              task.input.template.rules,
              sources,
            ),
          });
          continue;
        }
        if (!topic) {
          topic = {
            id: id(),
            lessonId: task.lessonId,
            courseId: task.input.courseId,
            noteId: task.input.noteId,
            parentId: null,
            title: b.title || "待归类",
            body: "",
            version: 0,
            human: false,
            sources: [],
            stale: false,
          };
          if (noteScope) {
            const { materialId, page } = position(b);
            if (materialId) {
              topic.outlinePosition = { materialId, page };
              const index = s.topics.findIndex(
                (t) =>
                  t.noteId === task.input.noteId &&
                  t.outlinePosition?.materialId === materialId &&
                  t.outlinePosition.page > page,
              );
              if (index >= 0) s.topics.splice(index, 0, topic);
              else s.topics.push(topic);
            } else s.topics.push(topic);
          } else s.topics.push(topic);
        }
        if (task.input.incomplete)
          b.content_md =
            "> ⚠ 本笔记基于不完整转录：" +
            task.input.incomplete.reasons.join("；") +
            "\n\n" +
            b.content_md;
        const { format, withoutSourceList } = require("./presentation.cjs");
        let body = format(b.content_md, task.input.template.rules, sources);
        const scopeConflict = topic.sources.some(
          (source) => !task.input.sources.some((r) => r.id === source.id),
        );
        if (noteScope && topic.body) {
          const original = withoutSourceList(
            topic.body,
            topic.sources,
          ).trimEnd();
          const addition = withoutSourceList(body, sources).trim();
          const existing = new Set(topic.sources.map((ref) => ref.id));
          sources = [
            ...topic.sources,
            ...sources.filter((ref) => !existing.has(ref.id)),
          ];
          const sourceList = format("", task.input.template.rules, sources);
          body =
            (original.includes(addition)
              ? original
              : original + "\n\n" + addition) + sourceList;
          check(
            body.length <= MAX_NOTE_CHARS,
            "合入后笔记章节超长，请为补充内容另建章节",
          );
        }
        const conflict =
          scopeConflict ||
          stale ||
          topic.human ||
          task.input.forceCandidate ||
          (baseline ? topic.version !== baseline.version : topic.version !== 0);
        if (conflict) {
          s.candidates.push({
            id: id(),
            taskId,
            topicId: topic.id,
            baseVersion: baseline?.version ?? 0,
            body,
            sources,
            status: "pending",
            createdAt: Date.now(),
            reason: scopeConflict
              ? "原笔记含本次范围外来源"
              : stale
                ? "转录已修订"
                : topic.human
                  ? "保护人工编辑"
                  : "笔记版本或重排范围需要确认",
          });
        } else {
          this.writeVersion(s, topic, body, sources, false);
        }
      }
      task.state = "succeeded";
      task.finishedAt = Date.now();
      if (task.firstContentMs === null)
        task.firstContentMs = task.finishedAt - task.createdAt;
      const l = task.lessonId ? this.lesson(task.lessonId) : null;
      if (l)
        l.submittedMs = Math.max(
          l.submittedMs,
          ...task.input.utterances.map((u) => u.endMs || 0),
        );
    });
  }
  writeVersion(s, t, body, sources, human) {
    s.revisions.push({
      id: id(),
      topicId: t.id,
      version: t.version,
      body: t.body,
      sources: clone(t.sources),
      human: t.human,
      createdAt: Date.now(),
    });
    Object.assign(t, {
      body,
      sources,
      version: t.version + 1,
      human,
      stale: false,
    });
  }
  candidate(cid, apply, expected) {
    const c = this.s.candidates.find(
      (c) => c.id === cid && c.status === "pending",
    );
    check(c, "候选已处理");
    const t = this.s.topics.find((t) => t.id === c.topicId);
    this.course(t.courseId);
    if (
      apply &&
      (t.version !== expected ||
        (c.kind !== "append" && t.version !== c.baseVersion))
    )
      fail("VERSION_CONFLICT", "候选基线已过期，请基于最新笔记重新生成");
    return this.tx((s) => {
      if (apply && c.kind === "append")
        require("./chapter-supplement.cjs").accept(this, t, c);
      else if (apply) this.writeVersion(s, t, c.body, c.sources, true);
      c.status = apply ? "applied" : "rejected";
    });
  }
  recover() {
    this.tx((s) => {
      for (const l of s.lessons) {
        if (["recording", "paused"].includes(l.recording)) {
          l.recording = "stopped";
          l.recovered = true;
        }
      }
      for (const t of s.tasks)
        if (["running", "queued"].includes(t.state)) {
          t.state = "failed";
          t.error = "上次运行中断，请重试原任务";
        }
    });
  }
}
function validateResult(r, input, { allowEmpty = false } = {}) {
  check(
    r &&
      r.schema_version === "1" &&
      Array.isArray(r.blocks) &&
      (allowEmpty || !!input.chapterOutline || r.blocks.length > 0) &&
      r.blocks.length <=
        (input.whole || input.kind === "study" || input.chapterOutline
          ? 2000
          : 50),
    "模型返回格式无效",
  );
  const ids = new Set(input.sources.map((r) => r.id));
  const required =
    input.noteScope &&
    new Set(
      input.sources
        .filter((r) =>
          input.noteScope.requiresSlides
            ? r.materialRole === "slides"
            : r.kind === "transcript",
        )
        .map((r) => r.id),
    );
  const seen = new Set();
  const sectionIds =
    input.chapterOutline && new Set(input.topics.map((t) => t.id));
  const primaryIds =
    sectionIds &&
    new Set(input.sources.filter((s) => !s.referenceOnly).map((s) => s.id));
  const scopeSlides =
    input.chapterOutline?.requiresSlides &&
    new Set(
      input.sources.filter((s) => s.materialRole === "slides").map((s) => s.id),
    );
  const assigned =
    sectionIds &&
    new Map(
      input.sources
        .filter((s) => s.kind === "transcript" && sectionIds.has(s.topicId))
        .map((s) => [s.id, s.topicId]),
    );
  for (const b of r.blocks) {
    check(
      typeof b.topic_id === "string" &&
        typeof b.title === "string" &&
        typeof b.content_md === "string" &&
        b.content_md.length > 0 &&
        b.content_md.length <= MAX_NOTE_CHARS,
      "模型笔记块无效",
    );
    check(!seen.has(b.topic_id), "同一主题重复更新");
    seen.add(b.topic_id);
    check(
      Array.isArray(b.source_ids) &&
        b.source_ids.length &&
        b.source_ids.every((s) => ids.has(s)),
      "模型引用了未授权或不存在的来源",
    );
    if (required)
      check(
        b.source_ids.some((id) => required.has(id)),
        input.noteScope.requiresSlides
          ? "模型生成了缺少所选课件依据的笔记章节"
          : "模型生成了缺少本次课堂转录依据的笔记章节",
      );
    if (sectionIds) {
      check(sectionIds.has(b.topic_id), "补充结果超出了指定的章节骨架");
      if (scopeSlides)
        check(
          b.source_ids.some((id) => scopeSlides.has(id)),
          "补充结果缺少所选课件页依据",
        );
      if (!input.context.topicId)
        check(
          b.source_ids.every(
            (id) => !assigned.has(id) || assigned.get(id) === b.topic_id,
          ),
          "转录已指定其他小节，请核对章节归属",
        );
      check(
        b.source_ids.some((id) => primaryIds.has(id)),
        "小节补充必须引用本批选定的材料或转录",
      );
    }
    check(
      ["teacher_explanation", "textbook_supplement", "inference"].includes(
        b.evidence_type,
      ),
      "来源类别无效",
    );
    check(
      !b.topic_id ||
        b.topic_id.startsWith("new:") ||
        input.topics.some((t) => t.id === b.topic_id),
      "未知主题 ID",
    );
  }
}
function normalizeTime(stream, start, end) {
  check(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end >= start,
    "时间范围无效",
  );
  return {
    startMs: Math.round(stream.originMs + start),
    endMs: Math.round(stream.originMs + end),
  };
}
function parseSrt(raw) {
  const blocks = raw
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/);
  let last = -1;
  return blocks.map((b) => {
    const lines = b.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    check(i >= 0, "SRT 缺少时间戳");
    const m = lines[i].match(
      /(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})/,
    );
    check(m, "SRT 时间戳无效");
    const v = m.slice(1).map(Number);
    const startMs = ((v[0] * 60 + v[1]) * 60 + v[2]) * 1000 + v[3],
      endMs = ((v[4] * 60 + v[5]) * 60 + v[6]) * 1000 + v[7];
    check(startMs >= last && endMs >= startMs, "SRT 时间顺序无效");
    last = startMs;
    return {
      text: lines.slice(i + 1).join("\n"),
      startMs,
      endMs,
      timing: "imported",
    };
  });
}
require("./study.cjs").install(Store);
module.exports = {
  Store,
  id,
  hash,
  clone,
  fail,
  check,
  text,
  atomicWrite,
  DEFAULT_TEMPLATE,
  validateResult,
  normalizeTime,
  parseSrt,
};
