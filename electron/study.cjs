// Course-owned resources; lesson IDs on topics/sources remain provenance only.
const { randomUUID, createHash } = require("node:crypto");
const uid = () => randomUUID();
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const copy = (x) => structuredClone(x);
function requireValue(v, message) {
  if (!v) throw new Error(message);
}
function migrate(s) {
  s.notebooks ||= [];
  s.conversations ||= [];
  s.artifacts ||= [];
  s.attachments ||= [];
  s.config.pricing ||= {
    inputPerMillion: null,
    outputPerMillion: null,
    currency: "CNY",
    budget: null,
  };
  for (const l of s.lessons) {
    l.startedAt ||= l.createdAt;
    l.autoAfterStop ??= true;
    if (!l.noteId) {
      const n = {
        id: uid(),
        courseId: l.courseId,
        name: l.name + "笔记",
        createdAt: l.createdAt,
      };
      s.notebooks.push(n);
      l.noteId = n.id;
    }
    for (const task of s.tasks.filter((t) => t.lessonId === l.id && t.input)) {
      task.input.courseId ||= l.courseId;
      task.input.noteId ||= l.noteId;
    }
    for (const t of s.topics.filter((t) => t.lessonId === l.id)) {
      t.courseId ||= l.courseId;
      t.noteId ||= l.noteId;
      t.parentId ??= null;
    }
  }
  s.schema = 3;
}
function gaps(end, ranges) {
  let cursor = 0;
  const missing = [];
  for (const r of ranges
    .filter((r) => Number.isFinite(r.startMs) && Number.isFinite(r.endMs))
    .sort((a, b) => a.startMs - b.startMs)) {
    if (r.startMs > cursor + 2)
      missing.push({ startMs: cursor, endMs: Math.min(end, r.startMs) });
    cursor = Math.max(cursor, r.endMs);
    if (cursor >= end) break;
  }
  if (cursor < end - 2) missing.push({ startMs: cursor, endMs: end });
  return missing.filter((r) => r.endMs > r.startMs);
}
function readiness(store, lid) {
  const l = store.lesson(lid),
    s = store.s;
  const chunks = s.chunks.filter((c) => c.lessonId === lid);
  const ranges = s.streams
    .filter((x) => x.lessonId === lid)
    .flatMap((x) => x.confirmed || []);
  ranges.push(
    ...chunks
      .filter((c) => c.transcribed)
      .map((c) => ({ startMs: c.startMs, endMs: c.endMs })),
  );
  const missing = gaps(l.captureMs || 0, ranges);
  const diskMissing = gaps(l.captureMs || 0, chunks);
  const review = s.utterances.filter(
    (u) => u.lessonId === lid && (u.needsReview || !u.final),
  ).length;
  const reasons = [];
  if (l.recording !== "stopped") reasons.push("录音尚未结束");
  if (l.captureMs && (!l.writeComplete || !l.asrFinalized))
    reasons.push("录音尾部或转写收尾尚未确认");
  if (diskMissing.length) reasons.push("录音写盘不完整");
  if (missing.length) reasons.push("存在未处理音频范围");
  if (review) reasons.push(`${review} 段转录待人工核对`);
  if (l.captureError) reasons.push(l.captureError);
  if (!s.utterances.some((u) => u.lessonId === lid && u.final))
    reasons.push("尚无定稿转录");
  return { complete: !reasons.length, missing, diskMissing, review, reasons };
}
function tokens(text) {
  return (
    String(text)
      .toLowerCase()
      .match(/[a-z0-9_]+|[\u4e00-\u9fff]{1,2}/g) || []
  );
}
function retrieve(sources, query, limit = 12) {
  const terms = new Set(tokens(query));
  return sources
    .map((source, index) => ({
      source,
      index,
      score: tokens(source.text).reduce((n, t) => n + Number(terms.has(t)), 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((x) => x.source);
}
function install(Store) {
  Store.prototype.lessonTopics = function (lid) {
    const l = this.lesson(lid);
    return this.s.topics.filter(
      (t) => t.noteId === l.noteId && t.courseId === l.courseId,
    );
  };
  Store.prototype.newNotebook = function (cid, name) {
    this.course(cid);
    requireValue(
      typeof name === "string" && name.trim() && name.length <= 120,
      "请输入笔记名称",
    );
    return this.tx((s) => {
      const n = {
        id: uid(),
        courseId: cid,
        name: name.trim(),
        createdAt: Date.now(),
      };
      s.notebooks.push(n);
      return n;
    });
  };
  Store.prototype.updateLesson = function (lid, a) {
    const l = this.lesson(lid);
    requireValue(
      !a.noteId ||
        this.s.notebooks.some(
          (n) => n.id === a.noteId && n.courseId === l.courseId,
        ),
      "目标笔记不属于本课程",
    );
    requireValue(
      a.startedAt == null || Number.isFinite(a.startedAt),
      "课堂日期无效",
    );
    requireValue(
      a.name == null ||
        (typeof a.name === "string" && a.name.trim() && a.name.length <= 120),
      "课堂标题无效",
    );
    return this.tx(() => {
      for (const k of ["noteId", "startedAt", "name", "autoAfterStop"])
        if (a[k] !== undefined) l[k] = a[k];
    });
  };
  Store.prototype.readiness = function (lid) {
    return readiness(this, lid);
  };
  Store.prototype.maybeWhole = function (lid) {
    const l = this.lesson(lid);
    if (
      l.deleted ||
      l.aiPaused ||
      this.s.config.mode === "off" ||
      l.mode !== "auto" ||
      !l.autoAfterStop ||
      !l.autoPending ||
      !this.readiness(lid).complete
    )
      return null;
    const task = this.enqueueWhole(lid);
    this.tx(() => {
      l.autoPending = false;
      l.wholeTaskId = task.id;
    });
    return task;
  };
  Store.prototype.enqueueWhole = function (lid, opts = {}) {
    const l = this.lesson(lid),
      ready = this.readiness(lid);
    requireValue(l.recording === "stopped", "请结束录音后再整理整课");
    requireValue(
      ready.complete || opts.allowIncomplete === true,
      "转录待补齐：" + ready.reasons.join("；"),
    );
    return this.enqueue(lid, {
      ...opts,
      all: true,
      incomplete: ready.complete ? null : ready,
    });
  };
  Store.prototype.courseSources = function (cid, scope = {}) {
    this.course(cid);
    const refs = [];
    for (const range of scope.materials || []) {
      const m = this.s.materials.find(
        (m) => m.id === range.id && m.courseId === cid,
      );
      requireValue(
        m &&
          Number.isInteger(range.from) &&
          Number.isInteger(range.to) &&
          range.from >= 1 &&
          range.to >= range.from &&
          range.to <= m.pages.length,
        "资料页码范围无效",
      );
      for (let p = range.from; p <= range.to; p++)
        refs.push({
          id: `p:${m.id}:${p}:${m.sha}`,
          kind: "material",
          targetId: m.id,
          name: m.name,
          page: p,
          version: m.sha,
          text: m.pages[p - 1],
        });
    }
    for (const nid of scope.noteIds || []) {
      requireValue(
        this.s.notebooks.some((n) => n.id === nid && n.courseId === cid),
        "笔记范围越界",
      );
      for (const t of this.s.topics.filter((t) => t.noteId === nid))
        refs.push({
          id: `n:${t.id}:${t.version}`,
          kind: "note",
          targetId: t.id,
          name: t.title,
          revision: t.version,
          text: t.body,
        });
    }
    for (const lid of scope.lessonIds || []) {
      const l = this.lesson(lid);
      requireValue(l.courseId === cid, "课堂范围越界");
      for (const u of this.s.utterances.filter(
        (u) => u.lessonId === lid && u.final,
      ))
        refs.push({
          id: `u:${u.id}:${u.revision}`,
          kind: "transcript",
          targetId: u.id,
          lessonId: lid,
          lessonName: l.name,
          startedAt: l.startedAt,
          revision: u.revision,
          startMs: u.startMs,
          endMs: u.endMs,
          text: u.text,
        });
    }
    return refs;
  };
  Store.prototype.conversation = function (a) {
    this.course(a.courseId);
    let c = this.s.conversations.find(
      (x) => x.id === a.id && x.courseId === a.courseId,
    );
    requireValue(!a.id || c, "对话不存在");
    if (a.scope) this.courseSources(a.courseId, a.scope);
    return this.tx((s) => {
      if (!c) {
        c = {
          id: uid(),
          courseId: a.courseId,
          name: "新对话",
          messages: [],
          draft: "",
          scope: {},
          createdAt: Date.now(),
        };
        s.conversations.push(c);
      }
      for (const k of ["name", "draft"])
        if (a[k] != null) {
          requireValue(
            typeof a[k] === "string" && a[k].length < 20000,
            "对话输入过长",
          );
          c[k] = a[k];
        }
      if (a.scope) c.scope = copy(a.scope);
      return c;
    });
  };
  Store.prototype.enqueueStudy = function (a) {
    const c = this.course(a.courseId);
    requireValue(
      ["chat", "preview-guide", "review-guide"].includes(a.kind),
      "学习任务类型无效",
    );
    const conversation = this.s.conversations.find(
      (x) => x.id === a.conversationId && x.courseId === c.id,
    );
    requireValue(a.kind !== "chat" || conversation, "请选择对话");
    requireValue(
      !conversation ||
        !this.s.tasks.some(
          (t) =>
            t.conversationId === conversation.id &&
            ["running", "queued"].includes(t.state),
        ),
      "此对话正在生成，请等待或取消",
    );
    const prompt =
      a.prompt ||
      (a.kind === "preview-guide"
        ? "生成预习提纲：概念、先修知识、待思考问题"
        : "生成复习资料：知识关系、易错点与有依据的考试要求");
    requireValue(
      typeof prompt === "string" && prompt.length <= 12000 && prompt.trim(),
      "请输入问题",
    );
    let refs = this.courseSources(c.id, a.scope || conversation?.scope || {});
    requireValue(refs.length, "请先选择课程资料、笔记或课堂");
    // Q&A retrieves within explicit course scope; study guides consume the full scope via batching.
    if (a.kind === "chat") refs = retrieve(refs, prompt, 20);
    const input = {
      kind: "study",
      studyKind: a.kind,
      prompt,
      sources: refs,
      topics: [],
      utterances: [],
      context: {},
      template: copy(c.template),
      provider: copy(this.s.config),
      history: copy(conversation?.messages || []),
    };
    return this.tx((s) => {
      const t = {
        id: uid(),
        courseId: c.id,
        conversationId: conversation?.id,
        type: "study",
        key: digest(input),
        input,
        state: "queued",
        lane: "background",
        createdAt: Date.now(),
        attempt: 0,
        preview: "",
        firstContentMs: null,
      };
      s.tasks.push(t);
      if (conversation) {
        conversation.messages.push({
          id: uid(),
          role: "user",
          text: prompt,
          taskId: t.id,
        });
        conversation.draft = "";
      }
      return t;
    });
  };
  Store.prototype.applyStudy = function (task, result) {
    const { validateResult } = require("./core.cjs");
    validateResult(result, task.input);
    requireValue(task.state === "running", "任务已取消");
    this.course(task.courseId);
    return this.tx((s) => {
      const body = result.blocks
        .map((b) => `## ${b.title}\n\n${b.content_md}`)
        .join("\n\n");
      const sources = [
        ...new Set(result.blocks.flatMap((b) => b.source_ids)),
      ].map((id) => copy(task.input.sources.find((r) => r.id === id)));
      if (task.conversationId) {
        const c = s.conversations.find((c) => c.id === task.conversationId);
        requireValue(c, "对话不存在");
        c.messages.push({
          id: uid(),
          role: "assistant",
          text: body,
          sources,
          taskId: task.id,
        });
      } else
        s.artifacts.push({
          id: uid(),
          courseId: task.courseId,
          name:
            task.input.studyKind === "preview-guide" ? "预习提纲" : "复习资料",
          body,
          sources,
          version: 1,
          createdAt: Date.now(),
        });
      task.result = result;
      task.state = "succeeded";
      task.finishedAt = Date.now();
      task.firstContentMs ??= task.finishedAt - task.createdAt;
    });
  };
  Store.prototype.deleteLesson = function (lid) {
    const l = this.lesson(lid);
    requireValue(l.recording === "stopped", "请先结束录音");
    requireValue(
      !this.s.tasks.some(
        (t) => t.lessonId === lid && ["queued", "running"].includes(t.state),
      ),
      "请先取消该课堂的生成任务",
    );
    // Soft deletion keeps source evidence and revision history. Shared materials/notebooks are untouched.
    return this.tx(() => {
      l.deleted = true;
      l.deletedAt = Date.now();
    });
  };
  Store.prototype.outline = function (a) {
    const m = this.s.materials.find((m) => m.id === a.materialId);
    requireValue(m, "课件不存在");
    this.course(m.courseId);
    const from = a.from || 1,
      to = a.to || m.pages.length;
    requireValue(
      Number.isInteger(from) &&
        Number.isInteger(to) &&
        from >= 1 &&
        to <= m.pages.length &&
        to >= from,
      "页范围无效",
    );
    const nodes = [];
    for (let p = from; p <= to; p++) {
      const title =
        (m.pages[p - 1] || "")
          .split(/\n/)
          .map((x) => x.trim())
          .find((x) => x.length > 1)
          ?.slice(0, 100) || `第 ${p} 页（待命名）`;
      const previous = nodes[nodes.length - 1];
      if (previous?.title === title) previous.to = p;
      else nodes.push({ id: uid(), title, parentId: null, from: p, to: p });
    }
    return this.tx(() => {
      m.outline = nodes;
      return nodes;
    });
  };
}
module.exports = { migrate, install, gaps, readiness, retrieve };
