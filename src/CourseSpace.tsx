import React, { useState, useEffect } from "react";
import { Markdown } from "./Markdown";
import * as pdfjs from "pdfjs-dist";
type Obj = Record<string, any>;
const invoke = (m: string, a: Obj = {}) => window.desktop.invoke(m, a);
const dateInput = (n: number) => {
  const d = new Date(n);
  return new Date(n - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function Sources({ sources }: { sources: Obj[] }) {
  return (
    <details className="source-details">
      <summary>
        查看依据 · {sources?.length || 0} 条（存在性已校验，内容支持关系待核对）
      </summary>
      {sources?.map((s, i) => (
        <details key={i}>
          <summary>
            {s.name || s.lessonName || "课堂转录"}{" "}
            {s.page
              ? `第 ${s.page} 页`
              : s.startMs != null
                ? `${Math.floor(s.startMs / 1000)}–${Math.floor(s.endMs / 1000)} 秒`
                : s.kind === "note"
                  ? `版本 ${s.revision}`
                  : "无时间戳"}
            {s.startedAt
              ? " · " + new Date(s.startedAt).toLocaleDateString()
              : ""}
          </summary>
          <p>{s.text}</p>
        </details>
      ))}
    </details>
  );
}
export function ScopePicker({
  s,
  cid,
  scope,
  onChange,
}: {
  s: Obj;
  cid: string;
  scope: Obj;
  onChange: (v: Obj) => void;
}) {
  const selected = scope.materials || [];
  const toggle = (key: string, id: string) =>
    onChange({
      ...scope,
      [key]: (scope[key] || []).includes(id)
        ? scope[key].filter((x: string) => x !== id)
        : [...(scope[key] || []), id],
    });
  return (
    <div className="scope-picker">
      <h4>资料与章节范围</h4>
      {s.materials
        .filter((m: Obj) => m.courseId === cid && m.pages.length)
        .map((m: Obj) => {
          const range = selected.find((r: Obj) => r.id === m.id);
          const update = (r: Obj) =>
            onChange({
              ...scope,
              materials: selected.map((x: Obj) => (x.id === m.id ? r : x)),
            });
          return (
            <div className="scope-item" key={m.id}>
              <label>
                <input
                  type="checkbox"
                  checked={!!range}
                  onChange={() =>
                    onChange({
                      ...scope,
                      materials: range
                        ? selected.filter((r: Obj) => r.id !== m.id)
                        : [
                            ...selected,
                            { id: m.id, from: 1, to: m.pages.length },
                          ],
                    })
                  }
                />
                {m.name}
              </label>
              {range && (
                <div className="range-inputs">
                  第{" "}
                  <input
                    aria-label={m.name + "起始页"}
                    type="number"
                    min="1"
                    max={m.pages.length}
                    value={range.from}
                    onChange={(e) =>
                      update({ ...range, from: +e.target.value })
                    }
                  />{" "}
                  至{" "}
                  <input
                    aria-label={m.name + "结束页"}
                    type="number"
                    min={range.from}
                    max={m.pages.length}
                    value={range.to}
                    onChange={(e) => update({ ...range, to: +e.target.value })}
                  />{" "}
                  页
                </div>
              )}
            </div>
          );
        })}
      <h4>课程笔记</h4>
      {s.notebooks
        .filter((n: Obj) => n.courseId === cid)
        .map((n: Obj) => (
          <label key={n.id}>
            <input
              type="checkbox"
              checked={(scope.noteIds || []).includes(n.id)}
              onChange={() => toggle("noteIds", n.id)}
            />
            {n.name}
          </label>
        ))}
      <h4>课堂转录</h4>
      {s.lessons
        .filter((l: Obj) => l.courseId === cid && !l.deleted)
        .sort((a: Obj, b: Obj) => b.startedAt - a.startedAt)
        .map((l: Obj) => (
          <label key={l.id}>
            <input
              type="checkbox"
              checked={(scope.lessonIds || []).includes(l.id)}
              onChange={() => toggle("lessonIds", l.id)}
            />
            {new Date(l.startedAt).toLocaleDateString()} · {l.name}
          </label>
        ))}
    </div>
  );
}
export function LessonSetup({
  s,
  course,
  lesson,
  onRun,
  onDone,
}: {
  s: Obj;
  course: Obj;
  lesson?: Obj;
  onRun: (fn: () => Promise<any>) => Promise<any>;
  onDone: (l: Obj) => void;
}) {
  const [name, setName] = useState(lesson?.name || "课堂记录"),
    [at, setAt] = useState(dateInput(lesson?.startedAt || Date.now())),
    [noteId, setNoteId] = useState(lesson?.noteId || ""),
    [context, setContext] = useState<Obj>(lesson?.context || {});
  return (
    <form
      className="settings-form lesson-setup"
      onSubmit={(e) => {
        e.preventDefault();
        void onRun(async () => {
          const l =
            lesson ||
            (await invoke("lesson.create", {
              courseId: course.id,
              name,
              startedAt: new Date(at).getTime(),
              noteId,
            }));
          await invoke("lesson.update", {
            lessonId: l.id,
            name,
            startedAt: new Date(at).getTime(),
            noteId: noteId || l.noteId,
          });
          await invoke("lesson.context", { lessonId: l.id, context });
          onDone(l);
        });
      }}
    >
      <label>
        课堂标题
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        实际上课时间
        <input
          required
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
        />
      </label>
      <label>
        目标课程笔记
        <select value={noteId} onChange={(e) => setNoteId(e.target.value)}>
          <option value="">为本课新建笔记</option>
          {s.notebooks
            .filter((n: Obj) => n.courseId === course.id)
            .map((n: Obj) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
        </select>
      </label>
      {["slides", "book"].map((kind) => (
        <label key={kind}>
          {kind === "slides" ? "课件" : "教材"}及 AI 处理范围
          <select
            value={context[kind]?.id || ""}
            onChange={(e) => {
              const m = s.materials.find((m: Obj) => m.id === e.target.value);
              setContext({
                ...context,
                [kind]: m ? { id: m.id, from: 1, to: m.pages.length } : null,
              });
            }}
          >
            <option value="">暂不关联</option>
            {s.materials
              .filter((m: Obj) => m.courseId === course.id && m.pages.length)
              .map((m: Obj) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
          {context[kind] && (
            <div className="range-inputs">
              从{" "}
              <input
                type="number"
                min="1"
                value={context[kind].from}
                onChange={(e) =>
                  setContext({
                    ...context,
                    [kind]: { ...context[kind], from: +e.target.value },
                  })
                }
              />{" "}
              到{" "}
              <input
                type="number"
                min={context[kind].from}
                value={context[kind].to}
                onChange={(e) =>
                  setContext({
                    ...context,
                    [kind]: { ...context[kind], to: +e.target.value },
                  })
                }
              />{" "}
              页
            </div>
          )}
        </label>
      ))}
      <button className="primary" type="submit">
        {lesson ? "保存课堂关联" : "创建课堂"}
      </button>
    </form>
  );
}
function Outline({
  m,
  onRun,
}: {
  m: Obj;
  onRun: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [nodes, setNodes] = useState<Obj[]>(m.outline || []);
  useEffect(() => setNodes(m.outline || []), [m.outline]);
  return (
    <details>
      <summary>课件主题结构 · {nodes.length} 个主题</summary>
      <button
        onClick={() =>
          void onRun(() => invoke("material.outline", { materialId: m.id }))
        }
      >
        从课件页标题建立主题
      </button>
      <p className="muted small">
        可将同主题页扩展为一个范围，删除重复节点；每个主题可选择父章节。
      </p>
      {nodes.map((n, i) => (
        <div className="outline-row" key={n.id}>
          <input
            aria-label="主题标题"
            value={n.title}
            onChange={(e) =>
              setNodes(
                nodes.map((x) =>
                  x.id === n.id ? { ...x, title: e.target.value } : x,
                ),
              )
            }
          />
          <select
            aria-label="父章节"
            value={n.parentId || ""}
            onChange={(e) =>
              setNodes(
                nodes.map((x) =>
                  x.id === n.id
                    ? { ...x, parentId: e.target.value || null }
                    : x,
                ),
              )
            }
          >
            <option value="">顶层主题</option>
            {nodes
              .filter((x) => x.id !== n.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
          </select>
          <input
            type="number"
            aria-label="主题起始页"
            value={n.from}
            onChange={(e) =>
              setNodes(
                nodes.map((x) =>
                  x.id === n.id ? { ...x, from: +e.target.value } : x,
                ),
              )
            }
          />
          <input
            type="number"
            aria-label="主题结束页"
            value={n.to}
            onChange={(e) =>
              setNodes(
                nodes.map((x) =>
                  x.id === n.id ? { ...x, to: +e.target.value } : x,
                ),
              )
            }
          />
          <button onClick={() => setNodes(nodes.filter((_, j) => j !== i))}>
            移除
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          setNodes([
            ...nodes,
            {
              id: crypto.randomUUID(),
              title: "新主题",
              parentId: null,
              from: 1,
              to: 1,
            },
          ])
        }
      >
        增加主题
      </button>
      <button
        onClick={() =>
          void onRun(() =>
            invoke("material.outlineSave", { materialId: m.id, nodes }),
          )
        }
      >
        保存主题结构
      </button>
    </details>
  );
}
function NoteSection({
  topic,
  onRun,
  s,
}: {
  topic: Obj;
  onRun: (fn: () => Promise<any>) => Promise<any>;
  s: Obj;
}) {
  const [draft, setDraft] = useState<string | null>(null),
    [version, setVersion] = useState(topic.version),
    [title, setTitle] = useState(topic.title),
    [parent, setParent] = useState(topic.parentId || "");
  return (
    <section className="note-section">
      <h4>
        {topic.title} <small>v{topic.version}</small>
      </h4>
      {draft === null ? (
        <Markdown>{topic.body || "暂无笔记内容"}</Markdown>
      ) : (
        <textarea
          rows={12}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <div className="row">
        <button
          onClick={() => {
            setDraft(topic.body);
            setVersion(topic.version);
          }}
        >
          编辑
        </button>
        {draft !== null && (
          <>
            <button
              onClick={() =>
                void onRun(async () => {
                  await invoke("note.save", {
                    topicId: topic.id,
                    version,
                    body: draft,
                  });
                  setDraft(null);
                })
              }
            >
              保存修改
            </button>
            <button
              onClick={() =>
                void onRun(async () => {
                  const url = await invoke("attachment.import", {
                    courseId: topic.courseId,
                  });
                  if (url) setDraft(draft + `\n![图片](${url})\n`);
                })
              }
            >
              插入图片
            </button>
            <button onClick={() => setDraft(null)}>放弃编辑</button>
          </>
        )}
      </div>
      <details>
        <summary>标题与主题层级</summary>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">顶层主题</option>
          {s.topics
            .filter((t: Obj) => t.noteId === topic.noteId && t.id !== topic.id)
            .map((t: Obj) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
        </select>
        <button
          onClick={() =>
            void onRun(() =>
              invoke("topic.structure", {
                id: topic.id,
                noteId: topic.noteId,
                title,
                parentId: parent,
              }),
            )
          }
        >
          保存层级
        </button>
      </details>
      <Sources sources={topic.sources} />
      {s.candidates
        .filter((c: Obj) => c.topicId === topic.id && c.status === "pending")
        .map((c: Obj) => (
          <details key={c.id}>
            <summary>待确认候选 · {c.reason}</summary>
            <Markdown>{c.body}</Markdown>
            <button
              onClick={() =>
                void onRun(() =>
                  invoke("candidate.apply", {
                    id: c.id,
                    version: topic.version,
                  }),
                )
              }
            >
              采用候选
            </button>
            <button
              onClick={() =>
                void onRun(() => invoke("candidate.reject", { id: c.id }))
              }
            >
              拒绝
            </button>
          </details>
        ))}
      <details>
        <summary>版本历史</summary>
        {s.revisions
          .filter((r: Obj) => r.topicId === topic.id)
          .map((r: Obj) => (
            <details key={r.id}>
              <summary>v{r.version}</summary>
              <Markdown>{r.body}</Markdown>
              <button
                onClick={() =>
                  void onRun(() =>
                    invoke("note.restore", {
                      revisionId: r.id,
                      version: topic.version,
                    }),
                  )
                }
              >
                恢复为新版本
              </button>
            </details>
          ))}
      </details>
    </section>
  );
}
function Artifact({
  item,
  onRun,
}: {
  item: Obj;
  onRun: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [draft, setDraft] = useState<string | null>(null),
    [version, setVersion] = useState(item.version);
  return (
    <article className="course-note">
      <h3>{item.name}</h3>
      {draft === null ? (
        <Markdown>{item.body}</Markdown>
      ) : (
        <textarea
          rows={10}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <div className="row">
        <button
          onClick={() => {
            setDraft(item.body);
            setVersion(item.version);
          }}
        >
          编辑
        </button>
        {draft !== null && (
          <button
            onClick={() =>
              void onRun(async () => {
                await invoke("artifact.save", {
                  id: item.id,
                  version,
                  body: draft,
                });
                setDraft(null);
              })
            }
          >
            保存
          </button>
        )}
        <button
          onClick={() =>
            void onRun(() =>
              invoke("study.export", { courseId: item.courseId, id: item.id }),
            )
          }
        >
          导出
        </button>
      </div>
      <Sources sources={item.sources} />
    </article>
  );
}
export function Budget({
  s,
  onRun,
}: {
  s: Obj;
  onRun: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [p, setP] = useState<Obj>(s.config.pricing || {});
  const total = s.tasks.reduce(
      (v: number, t: Obj) => v + (t.costReserved || 0),
      0,
    ),
    unknown = s.tasks.filter(
      (t: Obj) => t.costUnknown || t.usageMissing,
    ).length;
  return (
    <details className="budget-box">
      <summary>
        用量与文本费用 · {total.toFixed(4)} {p.currency || "CNY"}（含预留估算）
      </summary>
      <p>
        调用次数与金额分开计算。此预算仅保护文本生成，不包含听悟/其他 ASR 账单。
        {unknown > 0 && `${unknown} 个任务用量或价格未知，账单金额不能保证。`}
      </p>
      <div className="form-grid">
        {[
          ["inputPerMillion", "输入 / 百万 token"],
          ["outputPerMillion", "输出 / 百万 token"],
          ["budget", "本机累计文本预算"],
        ].map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min="0"
              step="any"
              value={p[key] ?? ""}
              onChange={(e) =>
                setP({
                  ...p,
                  [key]: e.target.value === "" ? null : +e.target.value,
                })
              }
            />
          </label>
        ))}
        <label>
          币种
          <select
            value={p.currency || "CNY"}
            onChange={(e) => setP({ ...p, currency: e.target.value })}
          >
            <option>CNY</option>
            <option>USD</option>
          </select>
        </label>
      </div>
      <button onClick={() => void onRun(() => invoke("budget.save", p))}>
        保存价格与预算
      </button>
      <p className="muted">
        没有填写预算时不限制金额；有预算但价格未知时暂停文本调用。失败请求保留预估额度，实际账单以服务商为准。
      </p>
    </details>
  );
}
export function CourseSpace({
  s,
  course,
  onRun,
  onOpen,
  onSettings,
  onTemplate,
}: {
  s: Obj;
  course: Obj;
  onRun: (fn: () => Promise<any>) => Promise<any>;
  onOpen: (id: string) => void;
  onSettings: () => void;
  onTemplate: () => void;
}) {
  const [tab, setTab] = useState("learn"),
    [chatId, setChatId] = useState(""),
    [newLesson, setNewLesson] = useState(false),
    [editLesson, setEditLesson] = useState<Obj | undefined>(),
    [noteId, setNoteId] = useState(""),
    [notename, setNotename] = useState(""),
    [confirm, setConfirm] = useState(""),
    [deleteId, setDeleteId] = useState(""),
    [taskHistoryOpen, setTaskHistoryOpen] = useState(false);
  const chats = s.conversations.filter((x: Obj) => x.courseId === course.id),
    chat = chats.find((x: Obj) => x.id === chatId) || chats[0],
    notes = s.notebooks.filter((x: Obj) => x.courseId === course.id),
    selectedNote = notes.find((n: Obj) => n.id === noteId) || notes[0];
  const [drafts, setDrafts] = useState<Obj>({}),
    [scopes, setScopes] = useState<Obj>({});
  const draft = chat ? (drafts[chat.id] ?? chat.draft) : "",
    scope = chat ? (scopes[chat.id] ?? chat.scope) : {};
  useEffect(() => {
    if (!chat || draft === chat.draft) return;
    const timer = setTimeout(
      () =>
        void onRun(() =>
          invoke("conversation.save", {
            id: chat.id,
            courseId: course.id,
            draft,
          }),
        ),
      600,
    );
    return () => clearTimeout(timer);
  }, [chat?.id, draft]);
  const updateScope = (value: Obj) => {
    if (!chat) return;
    setScopes((x) => ({ ...x, [chat.id]: value }));
    void onRun(() =>
      invoke("conversation.save", {
        id: chat.id,
        courseId: course.id,
        scope: value,
      }),
    );
  };
  const saveDraft = () =>
    chat
      ? invoke("conversation.save", { id: chat.id, courseId: course.id, draft })
      : Promise.resolve();
  const active = s.tasks.filter(
    (t: Obj) =>
      (t.courseId === course.id ||
        s.lessons.find((l: Obj) => l.id === t.lessonId)?.courseId ===
          course.id) &&
      ["queued", "running", "failed"].includes(t.state),
  );
  const pendingTasks = active.filter(
    (t: Obj) => t.state === "queued" || t.state === "running",
  ).length;
  useEffect(() => {
    if (pendingTasks > 0) setTaskHistoryOpen(true);
  }, [pendingTasks]);
  async function importMaterial(kind: string) {
    const m = await invoke("material.import", { courseId: course.id, kind });
    if (m?.ext === ".pdf" && !m.pages.length) {
      const bytes = await invoke("material.read", { id: m.id }),
        pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise,
        pages = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p),
          data = await page.getTextContent();
        pages.push(
          data.items.map((x: any) => x.str + (x.hasEOL ? "\n" : " ")).join(""),
        );
      }
      await invoke("material.index", { id: m.id, pages });
      await pdf.destroy();
    }
  }
  return (
    <div className="course-space">
      <div className="workspace-heading">
        <div>
          <h1>{course.name}</h1>
          <p>
            {s.materials.filter((m: Obj) => m.courseId === course.id).length}{" "}
            份资料 <span> / </span>{" "}
            {
              s.lessons.filter(
                (l: Obj) => l.courseId === course.id && !l.deleted,
              ).length
            }{" "}
            次课堂 <span> / </span> {notes.length} 份笔记
          </p>
        </div>
        <div className="row">
          <button onClick={onTemplate}>课程模板</button>
          <button onClick={onSettings}>API 与授权</button>
          <button
            className="primary"
            onClick={() => {
              setNewLesson(true);
              setEditLesson(undefined);
              setTab("lessons");
            }}
          >
            新建课堂
          </button>
        </div>
      </div>
      <nav className="course-nav">
        <button
          className={tab === "learn" ? "selected" : ""}
          onClick={() => setTab("learn")}
        >
          课程学习
        </button>
        <button
          className={tab === "lessons" ? "selected" : ""}
          onClick={() => setTab("lessons")}
        >
          课堂记录
        </button>
      </nav>
      {tab === "lessons" ? (
        <div className="lesson-management">
          {newLesson && (
            <div className="course-card">
              <h2>{editLesson ? "编辑课堂" : "新建课堂记录"}</h2>
              <LessonSetup
                key={editLesson?.id || "new"}
                s={s}
                course={course}
                lesson={editLesson}
                onRun={onRun}
                onDone={(l) => {
                  setNewLesson(false);
                  if (!editLesson) onOpen(l.id);
                }}
              />
              <button onClick={() => setNewLesson(false)}>关闭</button>
            </div>
          )}
          {s.lessons
            .filter((l: Obj) => l.courseId === course.id && !l.deleted)
            .sort((a: Obj, b: Obj) => b.startedAt - a.startedAt)
            .map((l: Obj) => (
              <article className="lesson-record" key={l.id}>
                <div>
                  <time>{new Date(l.startedAt).toLocaleString()}</time>
                  <h3>{l.name}</h3>
                  <p>
                    {l.recording === "stopped" ? "录音已结束" : "录音中 / 暂停"}{" "}
                    · {Math.floor(l.captureMs / 1000)} 秒 ·{" "}
                    {l.readiness?.complete ? "转录已就绪" : "待补齐"} ·{" "}
                    {
                      s.utterances.filter((u: Obj) => u.lessonId === l.id)
                        .length
                    }{" "}
                    段转录
                  </p>
                  <small>
                    {[l.context.slides, l.context.book]
                      .filter(Boolean)
                      .map(
                        (r: Obj) =>
                          `${s.materials.find((m: Obj) => m.id === r.id)?.name} p${r.from}–${r.to}`,
                      )
                      .join(" · ")}{" "}
                    · {notes.find((n: Obj) => n.id === l.noteId)?.name}
                  </small>
                </div>
                <div className="row">
                  <button className="primary" onClick={() => onOpen(l.id)}>
                    进入课堂
                  </button>
                  <button
                    onClick={() => {
                      setEditLesson(l);
                      setNewLesson(true);
                    }}
                  >
                    关联与日期
                  </button>
                  <button onClick={() => setDeleteId(l.id)}>删除</button>
                </div>
                {deleteId === l.id && (
                  <div>
                    <p>
                      删除后课堂从列表隐藏，保留录音、转录用于历史引用；课程共享资料和笔记不受影响。输入课堂标题确认。
                    </p>
                    <input
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                    <button
                      onClick={() =>
                        void onRun(async () => {
                          await invoke("lesson.delete", {
                            lessonId: l.id,
                            confirm,
                          });
                          setDeleteId("");
                          setConfirm("");
                        })
                      }
                    >
                      确认删除课堂
                    </button>
                  </div>
                )}
              </article>
            ))}
        </div>
      ) : (
        <div className="learning-grid">
          <section className="course-card source-column">
            <h2>资料与来源</h2>
            <div className="row">
              <button
                onClick={() => void onRun(() => importMaterial("slides"))}
              >
                导入课件
              </button>
              <button onClick={() => void onRun(() => importMaterial("book"))}>
                导入教材 / 笔记
              </button>
            </div>
            {!chat && <p>先新建对话，再选择本次学习使用的资料。</p>}
            {chat && (
              <ScopePicker
                s={s}
                cid={course.id}
                scope={scope}
                onChange={updateScope}
              />
            )}
            <details className="source-library" open={!chat}>
              <summary>资料原文与课件目录</summary>
              {s.materials
                .filter((m: Obj) => m.courseId === course.id)
                .map((m: Obj) => (
                  <details key={m.id}>
                    <summary>
                      {m.name} · {m.pages.length} 页
                    </summary>
                    <p className="muted">浏览内容不改变处理范围。</p>
                    <details>
                      <summary>查看文本资料</summary>
                      {m.pages.map((p: string, i: number) => (
                        <details key={i}>
                          <summary>第 {i + 1} 页</summary>
                          <p>{p || "无文本；扫描页需先在外部 OCR"}</p>
                        </details>
                      ))}
                    </details>
                    {m.kind === "slides" && <Outline m={m} onRun={onRun} />}
                  </details>
                ))}
            </details>
          </section>
          <section className="course-card chat-column">
            <div className="row between">
              <h2>课程对话</h2>
              <button
                onClick={() =>
                  void onRun(async () => {
                    await saveDraft();
                    const c = await invoke("conversation.save", {
                      courseId: course.id,
                      name: "新对话 " + (chats.length + 1),
                    });
                    setChatId(c.id);
                  })
                }
              >
                新建对话
              </button>
            </div>
            {!chat && (
              <div className="chat-empty">
                <h3>围绕课程资料提问</h3>
                <p>
                  新建一个对话，在左栏选择本次使用的资料。每个对话独立保存记录和草稿。
                </p>
              </div>
            )}
            <div className="chat-tabs">
              {chats.map((c: Obj) => (
                <button
                  className={chat?.id === c.id ? "selected" : ""}
                  key={c.id}
                  onClick={() =>
                    void onRun(async () => {
                      await saveDraft();
                      setChatId(c.id);
                    })
                  }
                >
                  {c.name}
                </button>
              ))}
            </div>
            {chat && (
              <>
                <input
                  className="chat-name"
                  aria-label="对话名称"
                  key={chat.id}
                  defaultValue={chat.name}
                  onBlur={(e) =>
                    void onRun(() =>
                      invoke("conversation.save", {
                        id: chat.id,
                        courseId: course.id,
                        name: e.target.value,
                      }),
                    )
                  }
                />
                <div className="chat-messages">
                  {!chat.messages.length && (
                    <div className="chat-empty">
                      <h3>这个对话还没有消息</h3>
                      <p>选择资料，然后在下方写下你的问题。</p>
                    </div>
                  )}
                  {chat.messages.map((m: Obj) => (
                    <article key={m.id} className={"message " + m.role}>
                      <small>{m.role === "user" ? "你" : "课程助手"}</small>
                      <Markdown>{m.text}</Markdown>
                      {m.sources && (
                        <>
                          <Sources sources={m.sources} />
                          <select
                            aria-label="保存回答到笔记"
                            defaultValue=""
                            onChange={(e) => {
                              const value = e.target.value;
                              if (value)
                                void onRun(() =>
                                  invoke("note.saveAnswer", {
                                    conversationId: chat.id,
                                    messageId: m.id,
                                    noteId: selectedNote?.id,
                                    topicId: value === "new" ? "" : value,
                                  }),
                                );
                              e.target.value = "";
                            }}
                          >
                            <option value="">保存回答到右侧所选笔记…</option>
                            <option value="new">新主题</option>
                            {s.topics
                              .filter((t: Obj) => t.noteId === selectedNote?.id)
                              .map((t: Obj) => (
                                <option key={t.id} value={t.id}>
                                  追加候选：{t.title}
                                </option>
                              ))}
                          </select>
                        </>
                      )}
                    </article>
                  ))}
                </div>
                <textarea
                  aria-label="课程问题"
                  rows={3}
                  placeholder="围绕已选课程资料提问…"
                  value={draft}
                  onChange={(e) =>
                    setDrafts((x) => ({ ...x, [chat.id]: e.target.value }))
                  }
                  onBlur={() => void onRun(saveDraft)}
                />
                <button
                  className="primary"
                  disabled={
                    !draft.trim() ||
                    s.tasks.some(
                      (t: Obj) =>
                        t.conversationId === chat.id &&
                        ["queued", "running"].includes(t.state),
                    )
                  }
                  onClick={() =>
                    void onRun(async () => {
                      await saveDraft();
                      await invoke("study.generate", {
                        courseId: course.id,
                        conversationId: chat.id,
                        kind: "chat",
                        prompt: draft,
                        scope,
                      });
                      setDrafts((x) => ({ ...x, [chat.id]: "" }));
                    })
                  }
                >
                  发送问题
                </button>
              </>
            )}
            {active.length > 0 && (
              <details
                className="course-task-history"
                open={taskHistoryOpen}
                onToggle={(event) =>
                  setTaskHistoryOpen(event.currentTarget.open)
                }
              >
                <summary>
                  整理任务{" "}
                  <span>
                    {pendingTasks > 0
                      ? `${pendingTasks} 个进行中`
                      : `${active.length} 条失败记录`}
                  </span>
                </summary>
                {active.map((t: Obj) => (
                  <div className="task-card" key={t.id}>
                    <b>
                      {t.progress?.stage || "生成任务"} ·{" "}
                      {t.state === "failed"
                        ? "失败"
                        : t.state === "running"
                          ? "进行中"
                          : "排队中"}
                    </b>
                    <p>{t.error}</p>
                    {t.state === "failed" ? (
                      <button
                        onClick={() =>
                          void onRun(() => invoke("task.retry", { id: t.id }))
                        }
                      >
                        重试未完成部分
                      </button>
                    ) : (
                      <button
                        onClick={() =>
                          void onRun(() => invoke("task.cancel", { id: t.id }))
                        }
                      >
                        取消
                      </button>
                    )}
                    {t.preview && (
                      <details>
                        <summary>未验证预览</summary>
                        <Markdown>{t.preview}</Markdown>
                      </details>
                    )}
                  </div>
                ))}
              </details>
            )}
          </section>
          <section className="course-card studio-column">
            <h2>笔记与学习资料</h2>
            <div className="row">
              <button
                disabled={!chat}
                onClick={() =>
                  void onRun(() =>
                    invoke("study.generate", {
                      courseId: course.id,
                      kind: "preview-guide",
                      scope,
                    }),
                  )
                }
              >
                生成预习提纲
              </button>
              <button
                disabled={!chat}
                onClick={() =>
                  void onRun(() =>
                    invoke("study.generate", {
                      courseId: course.id,
                      kind: "review-guide",
                      scope,
                    }),
                  )
                }
              >
                生成复习资料
              </button>
            </div>
            <p className="muted small">
              使用左侧当前对话选择的来源，可独立生成。
            </p>
            <select
              aria-label="课程笔记"
              value={selectedNote?.id || ""}
              onChange={(e) => setNoteId(e.target.value)}
            >
              {notes.map((n: Obj) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
            <div className="row">
              <input
                aria-label="新笔记名称"
                value={notename}
                placeholder="新笔记名称"
                onChange={(e) => setNotename(e.target.value)}
              />
              <button
                disabled={!notename.trim()}
                onClick={() =>
                  void onRun(async () => {
                    const n = await invoke("notebook.create", {
                      courseId: course.id,
                      name: notename,
                    });
                    setNoteId(n.id);
                    setNotename("");
                  })
                }
              >
                新建笔记
              </button>
            </div>
            {selectedNote && (
              <div className="row">
                <button
                  onClick={() =>
                    void onRun(() =>
                      invoke("note.create", {
                        noteId: selectedNote.id,
                        title: "新主题",
                      }),
                    )
                  }
                >
                  添加章节
                </button>
                <button
                  onClick={() =>
                    void onRun(() =>
                      invoke("study.export", {
                        courseId: course.id,
                        noteId: selectedNote.id,
                      }),
                    )
                  }
                >
                  导出笔记
                </button>
              </div>
            )}
            {selectedNote && (
              <article className="course-note">
                <h3>{selectedNote.name}</h3>
                {s.topics
                  .filter((t: Obj) => t.noteId === selectedNote.id)
                  .map((t: Obj) => (
                    <NoteSection key={t.id} topic={t} onRun={onRun} s={s} />
                  ))}
              </article>
            )}
            {s.artifacts
              .filter((a: Obj) => a.courseId === course.id)
              .map((a: Obj) => (
                <Artifact key={a.id} item={a} onRun={onRun} />
              ))}
          </section>
        </div>
      )}
      <Budget s={s} onRun={onRun} />
    </div>
  );
}
