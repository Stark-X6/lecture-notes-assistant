const fs = require("node:fs"),
  path = require("node:path");
const { id, clone, check, text, atomicWrite } = require("./core.cjs");
const attachment = require("./attachments.cjs");
function routes(context) {
  const get = () => context();
  return {
    "lesson.update": (a) => get().store.updateLesson(a.lessonId, a),
    "lesson.delete": async (a) => {
      const { store, scheduler, backfills, record, recordingBusy } = get(),
        l = store.lesson(a.lessonId);
      check(
        a.confirm === l.name,
        "请输入课堂标题确认：课堂将移入回收状态；引用及共享资源保留",
      );
      check(
        !recordingBusy && record?.lid !== l.id && !backfills.has(l.id),
        "请结束录音及转写后删除",
      );
      for (const t of store.s.tasks.filter(
        (t) => t.lessonId === l.id && ["queued", "running"].includes(t.state),
      ))
        scheduler.cancel(t.id);
      return store.deleteLesson(l.id);
    },
    "notebook.create": (a) => get().store.newNotebook(a.courseId, a.name),
    "conversation.save": (a) => get().store.conversation(a),
    "study.generate": (a) => get().store.enqueueStudy(a),
    "material.outline": (a) => get().store.outline(a),
    "material.outlineSave": (a) => {
      const { store } = get(),
        m = store.s.materials.find((m) => m.id === a.materialId);
      check(m);
      store.course(m.courseId);
      check(Array.isArray(a.nodes) && a.nodes.length <= 3000, "主题结构过大");
      const ids = new Set(a.nodes.map((n) => n.id));
      check(ids.size === a.nodes.length, "主题ID重复");
      for (const n of a.nodes) {
        text(n.id, 120);
        text(n.title, 120);
        check(
          n.title.trim() &&
            Number.isInteger(n.from) &&
            Number.isInteger(n.to) &&
            n.from >= 1 &&
            n.to >= n.from &&
            n.to <= m.pages.length,
          "主题页范围无效",
        );
        check(!n.parentId || ids.has(n.parentId), "父主题不存在");
        const seen = new Set([n.id]);
        let parent = n.parentId;
        while (parent) {
          check(!seen.has(parent), "主题结构存在循环");
          seen.add(parent);
          parent = a.nodes.find((x) => x.id === parent)?.parentId;
        }
      }
      store.tx(() => (m.outline = clone(a.nodes)));
    },
    "topic.structure": (a) => {
      const { store } = get(),
        t = store.s.topics.find((t) => t.id === a.id);
      check(t);
      store.course(t.courseId);
      const parent = store.s.topics.find(
        (t) => t.id === a.parentId && t.noteId === a.noteId,
      );
      check(!a.parentId || (parent && parent.id !== t.id), "父主题无效");
      const seen = new Set([t.id]);
      let p = parent;
      while (p) {
        check(!seen.has(p.id), "主题层级循环");
        seen.add(p.id);
        p = store.s.topics.find((x) => x.id === p.parentId);
      }
      store.tx(() => {
        t.title = text(a.title, 120);
        t.parentId = a.parentId || null;
      });
    },
    "note.create": (a) => {
      const { store } = get(),
        n = store.s.notebooks.find((n) => n.id === a.noteId);
      check(n);
      store.course(n.courseId);
      return store.tx((s) => {
        const t = {
          id: id(),
          courseId: n.courseId,
          noteId: n.id,
          title: text(a.title || "新主题", 120),
          body: "",
          version: 0,
          human: true,
          sources: [],
          parentId: null,
        };
        s.topics.push(t);
        return t;
      });
    },
    "note.saveAnswer": (a) => {
      const { store } = get(),
        n = store.s.notebooks.find((n) => n.id === a.noteId);
      check(n);
      store.course(n.courseId);
      const c = store.s.conversations.find(
        (c) => c.id === a.conversationId && c.courseId === n.courseId,
      );
      const m = c?.messages.find(
        (m) => m.id === a.messageId && m.role === "assistant",
      );
      check(m, "回答不存在");
      const t = store.s.topics.find(
        (t) => t.id === a.topicId && t.noteId === n.id,
      );
      return store.tx((s) => {
        if (t) {
          s.candidates.push({
            id: id(),
            topicId: t.id,
            baseVersion: t.version,
            body: t.body + "\n\n" + m.text,
            sources: [...clone(t.sources), ...clone(m.sources)],
            status: "pending",
            reason: "保存课程回答，请确认追加内容",
            createdAt: Date.now(),
          });
          return t;
        }
        const topic = {
          id: id(),
          courseId: n.courseId,
          noteId: n.id,
          title: text(a.title || "对话笔记", 120),
          body: m.text,
          sources: clone(m.sources),
          version: 1,
          human: true,
          parentId: null,
        };
        s.topics.push(topic);
        return topic;
      });
    },
    "artifact.save": (a) => {
      const { store } = get(),
        item = store.s.artifacts.find((x) => x.id === a.id);
      check(item);
      store.course(item.courseId);
      check(item.version === a.version, "学习资料已变化");
      return store.tx(() => {
        item.history ||= [];
        item.history.push({ version: item.version, body: item.body });
        item.body = text(a.body);
        item.version++;
      });
    },
    "study.export": async (a) => {
      const { store, dialog, win, shell } = get();
      store.course(a.courseId);
      let items;
      if (a.noteId) {
        check(
          store.s.notebooks.some(
            (n) => n.id === a.noteId && n.courseId === a.courseId,
          ),
        );
        items = store.s.topics
          .filter((t) => t.noteId === a.noteId)
          .map((t) => ({ ...t, name: t.title }));
      } else {
        const item = store.s.artifacts.find(
          (x) => x.id === a.id && x.courseId === a.courseId,
        );
        check(item);
        items = [item];
      }
      const result = await dialog.showOpenDialog(win, {
        title: "导出课程笔记与附件",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled) return;
      const dir = path.join(result.filePaths[0], "课程学习导出-" + Date.now());
      fs.mkdirSync(dir, { recursive: true });
      const exported = attachment.exportMarkdown(
        store,
        items.map((t) => "# " + t.name + "\n\n" + t.body).join("\n\n"),
        dir,
      );
      atomicWrite(path.join(dir, "notes.md"), exported.body);
      atomicWrite(
        path.join(dir, "sources.json"),
        JSON.stringify(
          items.map((t) => ({
            id: t.id,
            version: t.version,
            sources: t.sources,
          })),
          null,
          2,
        ),
      );
      atomicWrite(
        path.join(dir, "missing-attachments.json"),
        JSON.stringify(exported.missing, null, 2),
      );
      shell.showItemInFolder(path.join(dir, "notes.md"));
      return { directory: dir, missing: exported.missing };
    },
    "attachment.import": async (a) => {
      const { store, dialog, win } = get();
      store.course(a.courseId);
      const r = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
        ],
      });
      return r.canceled
        ? null
        : attachment.add(store, a.courseId, r.filePaths[0]);
    },
    "attachment.read": (a) => {
      const { store } = get(),
        item = store.s.attachments.find((x) => x.id === a.id);
      check(item, "附件缺失");
      store.course(item.courseId);
      return {
        mime: item.mime,
        data: fs.readFileSync(item.path).toString("base64"),
      };
    },
    "template.migrate": (a) => {
      const { store } = get();
      const l = a.lessonId
        ? store.lesson(a.lessonId)
        : {
            courseId: a.courseId,
            noteId: store.s.topics.find(
              (t) => a.topicIds?.includes(t.id) && t.courseId === a.courseId,
            )?.noteId,
          };
      store.course(l.courseId);
      check(
        Array.isArray(a.topicIds) &&
          a.topicIds.length > 0 &&
          a.topicIds.every((id) =>
            store.s.topics
              .filter((t) => t.noteId === l.noteId && t.courseId === l.courseId)
              .some((t) => t.id === id),
          ),
        "请选择本笔记中的主题",
      );
      // Migration works without transcripts: selected note bodies are explicit sources.
      const topics = clone(
        store.s.topics
          .filter((t) => t.noteId === l.noteId && t.courseId === l.courseId)
          .filter((t) => a.topicIds.includes(t.id)),
      );
      const input = {
        lessonId: l.id,
        courseId: l.courseId,
        noteId: l.noteId,
        utterances: [],
        topics,
        sources: topics.flatMap((t) => [
          {
            id: `n:${t.id}:${t.version}`,
            kind: "note",
            targetId: t.id,
            revision: t.version,
            text: t.body,
          },
          ...t.sources,
        ]),
        context: {},
        template: clone(store.course(l.courseId).template),
        provider: clone(store.s.config),
        forceCandidate: true,
        prompt:
          "仅调整所选主题的呈现格式，保留全部事实、批注、公式、图片和来源，不改变范围外主题。",
        migration: true,
      };
      return store.tx((s) => {
        const t = {
          id: id(),
          lessonId: l.id,
          courseId: l.courseId,
          type: "notes",
          input,
          key: require("./core.cjs").hash(input),
          state: "queued",
          lane: "background",
          createdAt: Date.now(),
          attempt: 0,
          preview: "",
          firstContentMs: null,
        };
        s.tasks.push(t);
        return t;
      });
    },
    "template.preview": (a) => {
      const { store } = get(),
        l = a.lessonId
          ? store.lesson(a.lessonId)
          : {
              courseId: a.courseId,
              noteId: store.s.topics.find(
                (t) =>
                  t.courseId === a.courseId &&
                  (!a.topicIds?.length || a.topicIds.includes(t.id)),
              )?.noteId,
            };
      store.course(l.courseId);
      const topics = clone(
        store.s.topics
          .filter((t) => t.noteId === l.noteId && t.courseId === l.courseId)
          .filter((t) => !a.topicIds?.length || a.topicIds.includes(t.id)),
      ).slice(0, a.topicIds?.length || 1);
      check(topics.length || l.id, "请先选择一个已有笔记主题");
      if (l.id && !topics.some((t) => t.body.trim()))
        return store.enqueue(l.id, {
          preview: true,
          template: { id: "preview", version: 0, rules: a.rules },
          topicIds: a.topicIds,
        });
      const sources = topics.flatMap((t) => [
        {
          id: `n:${t.id}:${t.version}`,
          kind: "note",
          targetId: t.id,
          text: t.body,
        },
        ...t.sources,
      ]);
      const input = {
        lessonId: l.id,
        courseId: l.courseId,
        noteId: l.noteId,
        utterances: [],
        topics,
        sources,
        context: { topicId: topics[0]?.id },
        template: { id: "preview", version: 0, rules: a.rules },
        provider: clone(store.s.config),
        prompt: "仅预览所选主题的格式与详略，不新增范围外内容。",
      };
      return store.tx((s) => {
        const t = {
          id: id(),
          lessonId: l.id,
          courseId: l.courseId,
          type: "preview",
          input,
          key: require("./core.cjs").hash(input),
          state: "queued",
          lane: "background",
          createdAt: Date.now(),
          attempt: 0,
          preview: "",
          firstContentMs: null,
        };
        s.tasks.push(t);
        return t;
      });
    },
    "budget.save": (a) => {
      const { store } = get();
      for (const k of ["inputPerMillion", "outputPerMillion", "budget"])
        check(
          a[k] === null || (Number.isFinite(a[k]) && a[k] >= 0),
          "金额必须为空或非负数",
        );
      check(["CNY", "USD"].includes(a.currency), "请选择币种");
      check(
        !store.s.tasks.some((t) => (t.costReserved || 0) > 0) ||
          a.currency === (store.s.config.pricing?.currency || "CNY"),
        "已有费用记录，不能直接切换累计预算币种；请使用原币种计价",
      );
      check(
        !store.s.tasks.some((t) => t.state === "running"),
        "请等待生成结束再调整预算",
      );
      store.tx(
        () =>
          (store.s.config.pricing = {
            inputPerMillion: a.inputPerMillion,
            outputPerMillion: a.outputPerMillion,
            budget: a.budget,
            currency: a.currency,
          }),
      );
    },
  };
}
module.exports = { routes };
