// A chapter outline belongs to a course notebook. Each submission adds evidence
// to its existing section IDs, even when the selected batch comes from a later class.
const { id, clone, hash, check, fail, text } = require("./core.cjs");
const {
  pageRefs,
  relevant,
  textbookPages,
  transcriptRefs,
} = require("./note-scope.cjs");
const { format, withoutSourceList } = require("./presentation.cjs");
const { appendParagraphs } = require("./markdown-prose.cjs");
const { qualifyEmphasis } = require("./lecture-evidence.cjs");
const { MAX_NOTE_CHARS } = require("./generation-limits.cjs");

function sections(store, notebook) {
  const byId = new Map(
    store.s.topics
      .filter(
        (t) => t.noteId === notebook.id && t.courseId === notebook.courseId,
      )
      .map((t) => [t.id, t]),
  );
  return notebook.outline.topicIds.map((id) => {
    const t = byId.get(id);
    check(t, "章节骨架缺少小节，请重新核对骨架");
    const path = [t.title],
      visited = new Set([id]);
    let parent = byId.get(t.parentId);
    while (parent && !visited.has(parent.id)) {
      path.unshift(parent.title);
      visited.add(parent.id);
      parent = byId.get(parent.parentId);
    }
    return {
      id,
      title: t.title,
      path: path.join(" / "),
      parentId: t.parentId || null,
      from: t.outlineRange?.from,
      to: t.outlineRange?.to,
      version: t.version,
      human: t.human,
      body: "",
      sources: [],
    };
  });
}
function fingerprint(notebook, topics) {
  return hash([
    notebook.outline.version,
    topics.map((t) => [t.id, t.parentId, t.title, t.from, t.to]),
  ]);
}
function stamp(store, noteId) {
  const n = store.s.notebooks.find((n) => n.id === noteId);
  return n?.outline ? fingerprint(n, sections(store, n)) : null;
}
function materialRefs(store, courseId, ranges) {
  check(Array.isArray(ranges), "补充资料范围无效");
  const refs = [];
  for (const r of ranges) {
    const m = store.s.materials.find(
      (m) => m.id === r?.id && m.courseId === courseId,
    );
    check(
      m && m.kind !== "transcript" && ["book", "slides"].includes(r.role),
      "请选择本课程的课件或教材",
    );
    check(
      Number.isInteger(r.from) &&
        Number.isInteger(r.to) &&
        r.from >= 1 &&
        r.from <= r.to &&
        r.to <= m.pages.length,
      "补充资料页码无效",
    );
    const pages = pageRefs(m, r.role, r.from, r.to).filter((s) =>
      s.text?.trim(),
    );
    check(pages.length, "所选资料页没有可提取的正文");
    refs.push(...pages);
  }
  return refs;
}
function lessonReferences(store, lesson, context, speech) {
  if (!speech.length) return [];
  const queries = speech.map((s) => s.text);
  const slides = context.slides
    ? materialRefs(store, lesson.courseId, [
        { ...context.slides, role: "slides" },
      ])
    : [];
  const chosen = slides.length <= 4 ? slides : relevant(slides, queries, 4);
  const book =
    context.book &&
    store.s.materials.find(
      (m) => m.courseId === lesson.courseId && m.id === context.book.id,
    );
  const excerpts =
    book && book.id !== context.slides?.id
      ? textbookPages(
          pageRefs(book, "book"),
          chosen.length ? chosen.map((s) => s.text) : queries,
        ).slice(0, 6)
      : [];
  return [...chosen, ...excerpts].map((s) => ({
    ...s,
    text: s.text.slice(0, 3600),
    referenceOnly: true,
  }));
}
function prepare(store, args, fromLesson = false, includeReferences = true) {
  const course = store.course(args.courseId);
  const n = store.s.notebooks.find(
    (n) => n.id === args.noteId && n.courseId === course.id,
  );
  check(n?.outline, "请先为目标笔记建立章节骨架");
  const lesson = args.lessonId ? store.lesson(args.lessonId) : null;
  check(
    !lesson || (!lesson.deleted && lesson.courseId === course.id),
    "课堂不属于本课程",
  );
  check(!lesson?.aiPaused, "本课 AI 已暂停");
  const allTopics = sections(store, n);
  const signature = fingerprint(n, allTopics);
  if (Object.hasOwn(args, "outlineStamp") && signature !== args.outlineStamp)
    fail("OUTLINE_CHANGED", "章节骨架已变更，请重新选择本段提交");
  check(args.uids == null || Array.isArray(args.uids), "转录选区无效");
  const uidSet = args.uids == null ? null : new Set(args.uids);
  let turns = [];
  if (fromLesson || uidSet?.size) {
    check(lesson, "请选择转录所属课堂");
    turns = store.s.utterances.filter(
      (u) =>
        u.final && u.lessonId === lesson.id && (!uidSet || uidSet.has(u.id)),
    );
    if (uidSet)
      check(
        turns.length === uidSet.size,
        "选中转录不存在、尚未定稿或不属于本课堂",
      );
  }
  const utterances = turns.map(({ history, ...u }) => ({ ...u, history: [] }));
  const primary = [
    ...transcriptRefs(store.s.utterances, lesson, turns),
    ...materialRefs(store, course.id, args.materials || []),
  ];
  const unique = new Map(primary.map((s) => [s.id, s]));
  check(unique.size, "请选择要补充的资料页或定稿转录");
  const ctx = fromLesson ? args.context || lesson.context : {};
  let eligible = allTopics;
  if (ctx.slides?.id === n.outline.materialId)
    eligible = eligible.filter(
      (t) => t.from <= ctx.slides.to && t.to >= ctx.slides.from,
    );
  const targetId = args.targetId || ctx.topicId || null;
  if (targetId) {
    eligible = eligible.filter((t) => t.id === targetId);
    check(eligible.length, "目标小节不在当前章节骨架或本课选页范围内");
  }
  check(eligible.length, "本课选页和章节骨架没有重合的小节，请调整范围");
  const referencePages =
    fromLesson && includeReferences
      ? lessonReferences(store, lesson, ctx, turns)
      : [];
  const sources = [
    ...unique.values(),
    ...referencePages.filter((p) => !unique.has(p.id)),
  ];
  return {
    courseId: course.id,
    noteId: n.id,
    lessonId: lesson?.id,
    provider: clone(store.s.config),
    template: clone(args.template || course.template),
    prompt: text(args.prompt || "", 4000),
    context: { topicId: targetId },
    sources,
    utterances,
    topics: eligible,
    whole: !!args.all,
    incomplete: args.incomplete || null,
    forceCandidate: !!args.all,
    chapterOutline: {
      signature,
      version: n.outline.version,
      requiresSlides: !!ctx.slides && ctx.slides.id !== n.outline.materialId,
      referenceScope:
        ctx.slides || ctx.book
          ? {
              slides: ctx.slides && [
                ctx.slides.id,
                ctx.slides.from,
                ctx.slides.to,
              ],
              book: ctx.book?.id,
            }
          : null,
      role: n.outline.role,
      materialId: n.outline.materialId,
      materialName: store.s.materials.find(
        (m) => m.id === n.outline.materialId && m.courseId === course.id,
      )?.name,
      from: n.outline.from,
      to: n.outline.to,
      topicIds: eligible.map((t) => t.id),
    },
  };
}
function sourceModes(ref) {
  return (
    ref.chapterAdditionModes ||
    (ref.chapterAddition ? [ref.chapterAddition] : [])
  );
}

// Restoring a revision also restores its sources. A task receipt remains in
// history, but only evidence still in the section or awaiting review is held.
function contributionCoverage(state) {
  const held = new Map();
  const rejected = new Set();
  const outlineVersions = new Map(
    state.notebooks.map((n) => [n.id, n.outline?.version]),
  );
  const currentTasks = new Set(
    state.tasks
      .filter(
        (t) =>
          t.supplement &&
          t.input.chapterOutline.version === outlineVersions.get(t.noteId),
      )
      .map((t) => t.id),
  );
  function include(topicId, sources) {
    if (!held.has(topicId)) held.set(topicId, new Set());
    const keys = held.get(topicId);
    for (const source of sources) {
      const modes = sourceModes(source);
      if (modes.length) keys.add(source.id);
      for (const mode of modes) keys.add(mode + ":" + source.id);
    }
  }
  for (const topic of state.topics) include(topic.id, topic.sources);
  for (const candidate of state.candidates) {
    if (candidate.status === "rejected") rejected.add(candidate.id);
    if (
      candidate.kind === "append" &&
      candidate.status === "pending" &&
      currentTasks.has(candidate.taskId)
    )
      include(candidate.topicId, candidate.sources);
  }
  const has = (topicId, sourceId, mode) =>
    held.get(topicId)?.has(mode ? mode + ":" + sourceId : sourceId);
  const released = (part, mode) =>
    rejected.has(part.candidateId)
      ? part.sourceIds
      : part.sourceIds.filter((id) => !has(part.topicId, id, mode));
  return { has, released };
}

function enqueue(store, args, fromLesson = false) {
  const input = prepare(store, args, fromLesson, false);
  const selected = input.sources.filter((s) => !s.referenceOnly);
  const selectedIds = new Set(selected.map((s) => s.id));
  const routeKey = hash([
    input.noteId,
    input.chapterOutline.signature,
    input.chapterOutline.topicIds,
    input.context.topicId,
    input.provider.mode,
    input.chapterOutline.referenceScope,
  ]);
  const batchKey = (refs) =>
    hash([routeKey, refs.map((s) => s.id).sort(), input.prompt]);
  const requestedKey = batchKey(selected);
  const previous = store.s.tasks.filter(
    (t) => t.supplement && t.routeKey === routeKey && t.state !== "cancelled",
  );
  const coverage = contributionCoverage(store.s);
  const handled = new Set();
  const withdrawn = new Set();
  const reserved = new Set();
  let same, covering;
  for (const t of previous) {
    let reusable =
      t.state !== "failed" ||
      t.input.provider.version === input.provider.version;
    let priorIds = [];
    if (t.state === "queued" || t.state === "running") {
      priorIds = t.input.sources
        .filter((s) => !s.referenceOnly)
        .map((s) => s.id);
      for (const sourceId of priorIds) reserved.add(sourceId);
    } else if (t.state === "succeeded") {
      if (t.contributions) {
        for (const part of t.contributions) {
          const released = new Set(
            coverage.released(part, input.provider.mode),
          );
          if (released.size) reusable = false;
          for (const sourceId of part.sourceIds) {
            if (!released.has(sourceId)) priorIds.push(sourceId);
            else if (!coverage.has(part.topicId, sourceId, input.provider.mode))
              withdrawn.add(sourceId);
          }
        }
      } else priorIds = t.matchedSourceIds || [];
    }
    if (reusable && t.batchKey === requestedKey) same = t;
    for (const sourceId of priorIds) handled.add(sourceId);
    if (priorIds.some((id) => selectedIds.has(id))) covering = t;
  }
  const needsRecovery = (s) => withdrawn.has(s.id) && !reserved.has(s.id);
  if (
    same &&
    (same.state !== "succeeded" ||
      same.noMatch ||
      !selected.some(needsRecovery))
  )
    return { ...same, duplicate: true };
  const fresh = selected.filter((s) => !handled.has(s.id) || needsRecovery(s));
  if (!fresh.length && covering) return { ...covering, duplicate: true };
  const allowed = new Set(fresh.map((s) => s.id));
  input.sources = input.sources.filter(
    (s) => s.referenceOnly || allowed.has(s.id),
  );
  input.utterances = input.utterances.filter((u) =>
    allowed.has(`u:${u.id}:${u.revision}`),
  );
  if (fromLesson) {
    const lesson = store.lesson(args.lessonId);
    input.sources.push(
      ...lessonReferences(
        store,
        lesson,
        args.context || lesson.context,
        input.utterances,
      ).filter((ref) => !allowed.has(ref.id)),
    );
  }
  const freshKey = batchKey(fresh);
  const t = {
    id: id(),
    type: "notes",
    courseId: input.courseId,
    lessonId: input.lessonId,
    noteId: input.noteId,
    supplement: true,
    routeKey,
    batchKey: freshKey,
    key: hash([
      freshKey,
      input.sources.map((s) => s.id),
      input.provider.version,
    ]),
    input,
    state: "queued",
    lane: fromLesson && !input.whole ? "live" : "background",
    createdAt: args.submittedAt || Date.now(),
    attempt: 0,
    firstContentMs: null,
    preview: "",
    error: null,
    usage: null,
  };
  if (
    input.chapterOutline.requiresSlides &&
    !input.sources.some((s) => s.materialRole === "slides")
  ) {
    t.state = "succeeded";
    t.finishedAt = Date.now();
    t.noMatch = true;
    t.matchedSourceIds = [];
    t.noMatchReason = "本批内容没有匹配到所选课件页，可调整范围后补充。";
  }
  return store.tx((s) => {
    s.tasks.push(t);
    if (input.lessonId)
      store.event(input.lessonId, "submission.created", {
        taskId: t.id,
        sourceIds: fresh.map((s) => s.id),
      });
    return t;
  });
}
function append(topic, addition, refs, rules) {
  const original = withoutSourceList(topic.body, topic.sources).trimEnd();
  const byId = new Map(topic.sources.map((s) => [s.id, s]));
  for (const ref of refs) {
    const old = byId.get(ref.id);
    if (!old) byId.set(ref.id, ref);
    else if (
      ref.chapterAddition &&
      !sourceModes(old).includes(ref.chapterAddition)
    ) {
      const modes = [...sourceModes(old), ref.chapterAddition];
      byId.set(ref.id, {
        ...old,
        chapterAddition: ref.chapterAddition,
        ...(modes.length > 1 ? { chapterAdditionModes: modes } : {}),
        referenceOnly: false,
      });
    }
  }
  const sources = [...byId.values()];
  const updated = appendParagraphs(original, addition);
  const body = updated + format("", rules, sources);
  check(body.length <= MAX_NOTE_CHARS, "合入后章节超长，请拆分补充");
  return { body, sources };
}
function apply(store, s, t, result) {
  const input = t.input;
  check(
    stamp(store, input.noteId) === input.chapterOutline.signature,
    "章节骨架已变更，请按当前骨架重新提交",
  );
  const evidence = new Map(input.sources.map((s) => [s.id, s]));
  const matched = new Set();
  t.contributions = [];
  const turns = new Map(
    s.utterances
      .filter((u) => u.lessonId === input.lessonId)
      .map((u) => [u.id, u]),
  );
  for (const b of result.blocks) {
    const topic = s.topics.find(
      (v) => v.id === b.topic_id && v.noteId === input.noteId,
    );
    const baseline = input.topics.find((v) => v.id === topic.id);
    const refs = [...new Set(b.source_ids)].map((id) => {
      const ref = clone(evidence.get(id));
      if (!ref.referenceOnly) ref.chapterAddition = input.provider.mode;
      return ref;
    });
    const credit = {
      topicId: topic.id,
      sourceIds: refs.filter((r) => !r.referenceOnly).map((r) => r.id),
    };
    t.contributions.push(credit);
    for (const id of credit.sourceIds) matched.add(id);
    if (alreadyAdded(topic, credit.sourceIds, input.provider.mode)) continue;
    let draft = qualifyEmphasis(b.content_md, refs);
    if (input.incomplete)
      draft =
        "> ⚠ 本笔记基于不完整转录：" +
        input.incomplete.reasons.join("；") +
        "\n\n" +
        draft;
    const addition = format(draft, input.template.rules, []).trim();
    check(addition, "小节补充内容为空");
    const updated = append(topic, addition, refs, input.template.rules);

    const changedSpeech = refs.some(
      (ref) =>
        ref.kind === "transcript" &&
        turns.get(ref.targetId)?.revision !== ref.revision,
    );
    if (
      input.forceCandidate ||
      topic.human ||
      topic.stale ||
      changedSpeech ||
      topic.version !== baseline.version
    ) {
      credit.candidateId = id();
      s.candidates.push({
        id: credit.candidateId,
        kind: "append",
        taskId: t.id,
        topicId: topic.id,
        baseVersion: topic.version,
        addition,
        body: updated.body,
        sources: refs,
        status: "pending",
        createdAt: Date.now(),
        reason: changedSpeech
          ? "转录已修订，请核对后追加"
          : "确认后追加到该小节",
      });
    } else store.writeVersion(s, topic, updated.body, updated.sources, false);
  }
  t.matchedSourceIds = [...matched];
  t.noMatch = !result.blocks.length;
  t.state = "succeeded";
  t.finishedAt = Date.now();
  t.firstContentMs ??= t.finishedAt - t.createdAt;
  if (
    input.lessonId &&
    input.utterances.length &&
    store.lesson(input.lessonId).noteId === input.noteId
  ) {
    const l = store.lesson(input.lessonId);
    l.submittedMs = input.utterances.reduce(
      (n, u) => Math.max(n, u.endMs || 0),
      l.submittedMs || 0,
    );
  }
}
function alreadyAdded(topic, ids, mode) {
  const incorporated = new Set(
    topic.sources.filter((s) => sourceModes(s).includes(mode)).map((s) => s.id),
  );
  return ids.length > 0 && ids.every((id) => incorporated.has(id));
}
function accept(store, t, c) {
  const task = store.s.tasks.find((job) => job.id === c.taskId);
  check(
    task && stamp(store, t.noteId) === task.input.chapterOutline.signature,
    "章节骨架已变更，请按当前骨架重新提交",
  );
  if (
    alreadyAdded(
      t,
      c.sources.filter((s) => !s.referenceOnly).map((s) => s.id),
      task.input.provider.mode,
    )
  )
    return;
  const updated = append(t, c.addition, c.sources, task.input.template.rules);
  store.writeVersion(store.s, t, updated.body, updated.sources, true);
}
function mockResult(input) {
  const groups = new Map();
  const specificFirst = [...input.topics].sort(
    (a, b) =>
      a.to - a.from - (b.to - b.from) ||
      (b.path?.length || 0) - (a.path?.length || 0),
  );
  for (const source of input.sources.filter((s) => !s.referenceOnly)) {
    const assigned = input.context?.topicId || source.topicId;
    const topic = assigned
      ? input.topics.find((t) => t.id === assigned)
      : specificFirst.find((t) => source.text.includes(t.title)) ||
        specificFirst.find(
          (t) =>
            source.targetId === input.chapterOutline.materialId &&
            source.page >= t.from &&
            source.page <= t.to,
        );
    if (!topic) continue;
    if (!groups.has(topic.id))
      groups.set(topic.id, {
        topic_id: topic.id,
        title: topic.title,
        content_md: "> 模拟补充 · 未调用真实 API",
        source_ids: [],
        evidence_type: "inference",
      });
    const b = groups.get(topic.id);
    b.source_ids.push(source.id);
    if (input.chapterOutline.requiresSlides) {
      const ref = input.sources.find((s) => s.materialRole === "slides");
      if (!ref) {
        groups.delete(topic.id);
        continue;
      }
      if (!b.source_ids.includes(ref.id)) b.source_ids.push(ref.id);
    }
    b.content_md += "\n\n" + source.text.slice(0, 300);
  }
  return { schema_version: "1", blocks: [...groups.values()] };
}
module.exports = {
  prepare,
  enqueue,
  stamp,
  apply,
  accept,
  mockResult,
  contributionCoverage,
};
