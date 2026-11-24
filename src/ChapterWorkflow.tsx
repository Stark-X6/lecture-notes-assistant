import { useReducer, useState } from "react";
import {
  CandidateReview,
  depthStyle,
  notebookRows,
  pagesLabel,
  treeRows,
  type Run,
} from "./NotebookSections";
import { CourseTranscriptSelection } from "./CourseTranscriptSelection";

type Obj = Record<string, any>;
type Role = "slides" | "book";
type Range = { from: number; to: number };
type Primary = Range & { materialId: string; role: Role };
type PrimaryDraft = Primary & { usingDefaultPages?: boolean };
type MaterialRange = Range & { id: string; role: Role };
type DraftSection = Range & {
  key: string;
  title: string;
  parentKey: string | null;
};
type Batch = {
  materials: MaterialRange[];
  lessonId: string;
  uids: string[];
  useSelected: boolean;
  targetId: string;
  prompt: string;
};
export type ChapterDrafts = Map<string, unknown>;
const invoke = (method: string, args: Obj) =>
  window.desktop.invoke(method, args);
const roleLabel = (role: Role) => (role === "book" ? "教材" : "课件");
const materialRole = (material?: Obj): Role =>
  material?.kind === "book" ? "book" : "slides";
function initialPrimary(
  material?: Obj,
  role = materialRole(material),
): PrimaryDraft {
  return {
    materialId: material?.id || "",
    role,
    from: 1,
    to: role === "book" ? 1 : material?.pages.length || 1,
    usingDefaultPages: true,
  };
}
const isPending = (task: Obj) =>
  task.state === "queued" || task.state === "running";
const validRange = (r: Range, min: number, max: number) =>
  Number.isInteger(r.from) &&
  Number.isInteger(r.to) &&
  r.from >= min &&
  r.to <= max &&
  r.to >= r.from;

// Keep unconfirmed edits when the dialog closes, including a trip to select transcript rows.
function useDraft<T>(drafts: ChapterDrafts, key: string, fallback: T) {
  const [, refresh] = useReducer((v: number) => v + 1, 0);
  const value = drafts.has(key) ? (drafts.get(key) as T) : fallback;
  return [
    value,
    (next: T) => {
      drafts.set(key, next);
      refresh();
    },
  ] as const;
}

function PageRange({
  value,
  label,
  min,
  max,
  onChange,
}: {
  value: Range;
  label: string;
  min: number;
  max: number;
  onChange: (r: Range) => void;
}) {
  return (
    <span className="chapter-range">
      第{" "}
      <input
        type="number"
        aria-label={label + "起始页"}
        min={min}
        max={max}
        value={value.from || ""}
        onChange={(e) => onChange({ ...value, from: Number(e.target.value) })}
      />
      至{" "}
      <input
        type="number"
        aria-label={label + "结束页"}
        min={value.from || min}
        max={max}
        value={value.to || ""}
        onChange={(e) => onChange({ ...value, to: Number(e.target.value) })}
      />{" "}
      页
    </span>
  );
}

function RoleSelect({
  role,
  label,
  onChange,
}: {
  role: Role;
  label: string;
  onChange: (r: Role) => void;
}) {
  return (
    <select
      aria-label={label}
      value={role}
      onChange={(e) => onChange(e.target.value as Role)}
    >
      <option value="slides">课件</option>
      <option value="book">教材</option>
    </select>
  );
}

export function chapterTaskStatus(task: Obj) {
  if (task.state === "failed") return "处理失败";
  if (task.state === "cancelled") return "已取消";
  if (task.state === "queued") return "排队中";
  if (task.state === "running") return "处理中";
  if (task.type === "outline")
    return task.appliedVersion ? "已确认" : "待预览确认";
  return task.noMatch || task.result?.noMatch ? "未匹配章节" : "已完成";
}

function TaskStatus({ task, onRun }: { task: Obj; onRun: Run }) {
  const retry = task.state === "failed" || task.state === "cancelled";
  return (
    <div className="chapter-task">
      <strong>{chapterTaskStatus(task)}</strong>
      {task.progress?.stage && <span>{task.progress.stage}</span>}
      {task.error && <p className="inline-error">{task.error}</p>}
      {(isPending(task) || retry) && (
        <button
          type="button"
          onClick={() =>
            void onRun(() =>
              invoke(retry ? "task.retry" : "task.cancel", { id: task.id }),
            )
          }
        >
          {retry ? "重试原任务" : "取消任务"}
        </button>
      )}
    </div>
  );
}

function OutlinePreview({
  task,
  notebook,
  primary,
  drafts,
  busy,
  onRun,
  onApplied,
}: {
  task: Obj;
  notebook: Obj;
  primary: Primary;
  drafts: ChapterDrafts;
  busy: boolean;
  onRun: Run;
  onApplied: () => void;
}) {
  const [sections, setSections] = useDraft<DraftSection[]>(
    drafts,
    "outline:" + task.id,
    task.result.sections,
  );
  const [focus, setFocus] = useState(sections[0]?.key || "");
  const rows = treeRows(
    sections,
    (s) => s.key,
    (s) => s.parentKey,
  );
  const row = rows.find((r) => r.item.key === focus) || rows[0];
  const current = row?.item;
  const parents = rows.filter(
    (r) =>
      r.item.key !== current?.key &&
      !r.parents.some((p) => p.key === current?.key),
  );
  const siblings = sections.filter((s) => s.parentKey === current?.parentKey);
  const index = siblings.findIndex((s) => s.key === current?.key);
  const invalid = rows.find(({ item, parents }) => {
    const bounds = parents.at(-1) || primary;
    return (
      !item.title.trim() ||
      parents.length >= 6 ||
      !validRange(item, bounds.from, bounds.to)
    );
  });
  const edit = (updates: Partial<DraftSection>) =>
    setSections(
      sections.map((s) => (s.key === current.key ? { ...s, ...updates } : s)),
    );
  function move(direction: number) {
    const next = [...sections];
    const a = next.indexOf(current),
      b = next.indexOf(siblings[index + direction]);
    if (a < 0 || b < 0) return;
    [next[a], next[b]] = [next[b], next[a]];
    setSections(next);
  }
  function add() {
    const section = {
      key: crypto.randomUUID(),
      title: "新章节",
      parentKey: current?.parentKey ?? null,
      from: current?.from || primary.from,
      to: current?.to || primary.to,
    };
    setSections([...sections, section]);
    setFocus(section.key);
  }
  return (
    <div className="chapter-preview">
      <h3>预览与编辑 · {sections.length} 个章节</h3>
      <div className="chapter-split">
        <nav aria-label="草稿章节" className="chapter-tree">
          {rows.map(({ item, parents }) => (
            <button
              type="button"
              key={item.key}
              aria-pressed={item.key === current?.key}
              style={depthStyle(parents.length)}
              onClick={() => setFocus(item.key)}
            >
              <span>{item.title || "未命名章节"}</span>
              <small>{pagesLabel(item.from, item.to)}</small>
            </button>
          ))}
        </nav>
        {current && (
          <div className="chapter-fields">
            <label>
              章节标题
              <input
                value={current.title}
                maxLength={120}
                onChange={(e) => edit({ title: e.target.value })}
              />
            </label>
            <label>
              上级章节
              <select
                aria-label="上级章节"
                value={current.parentKey || ""}
                onChange={(e) => edit({ parentKey: e.target.value || null })}
              >
                <option value="">顶层章节</option>
                {parents.map(({ item, parents }) => (
                  <option key={item.key} value={item.key}>
                    {[...parents, item].map((s) => s.title).join(" › ")}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <div className="field-caption">章节来源页</div>
              <PageRange
                label="章节来源"
                min={primary.from}
                max={primary.to}
                value={current}
                onChange={edit}
              />
            </div>
            <div className="row chapter-row-actions">
              <button
                type="button"
                disabled={index <= 0}
                onClick={() => move(-1)}
              >
                上移
              </button>
              <button
                type="button"
                disabled={index < 0 || index >= siblings.length - 1}
                onClick={() => move(1)}
              >
                下移
              </button>
              <button
                type="button"
                onClick={() => {
                  setSections(
                    sections
                      .filter((s) => s.key !== current.key)
                      .map((s) =>
                        s.parentKey === current.key
                          ? { ...s, parentKey: current.parentKey }
                          : s,
                      ),
                  );
                }}
              >
                移除章节
              </button>
            </div>
          </div>
        )}
      </div>
      {invalid && (
        <p className="inline-error">
          请检查「{invalid.item.title || "未命名章节"}
          」的标题、层级与页码。子章节的页码须在上级范围内，最多六层。
        </p>
      )}
      <div className="row between">
        <button type="button" onClick={add}>
          增加同级章节
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !rows.length || !!invalid}
          onClick={() =>
            void onRun(async () => {
              await invoke("notebook.outlineApply", {
                courseId: notebook.courseId,
                noteId: notebook.id,
                taskId: task.id,
                sections: rows.map((r) => r.item),
              });
              drafts.delete("outline:" + task.id);
              onApplied();
            })
          }
        >
          确认章节骨架
        </button>
      </div>
    </div>
  );
}

function OutlineForm({
  tasks,
  notebook,
  materials,
  drafts,
  busy,
  onRun,
  onApplied,
}: {
  tasks: Obj[];
  notebook: Obj;
  materials: Obj[];
  drafts: ChapterDrafts;
  busy: boolean;
  onRun: Run;
  onApplied: () => void;
}) {
  const version = notebook.outline?.version || 0;
  const openTasks = tasks.filter(
    (t) =>
      t.type === "outline" &&
      !t.appliedVersion &&
      (t.baseOutlineVersion || 0) === version,
  );
  const latest = openTasks[0];
  const [lastDraftId, setLastDraftId] = useDraft(
    drafts,
    "active-draft:" + notebook.id,
    "",
  );
  const [primary, setPrimary] = useDraft<PrimaryDraft>(
    drafts,
    "primary:" + notebook.id,
    latest?.primary || notebook.outline || initialPrimary(materials[0]),
  );
  const material = materials.find((m) => m.id === primary.materialId);
  const matches = openTasks.filter((t) => {
    const p = t.primary || t;
    return (
      p.materialId === primary.materialId &&
      p.role === primary.role &&
      p.from === primary.from &&
      p.to === primary.to
    );
  });
  const task = matches.find((t) => t.id === lastDraftId) || matches[0];
  if (!materials.length)
    return <p>先在课程空间导入课件或教材，完成页码索引后即可建立骨架。</p>;
  return (
    <>
      <form
        className="chapter-fields"
        onSubmit={(e) => {
          e.preventDefault();
          void onRun(async () => {
            const created = await invoke("notebook.outlineDraft", {
              courseId: notebook.courseId,
              noteId: notebook.id,
              materialId: primary.materialId,
              role: primary.role,
              from: primary.from,
              to: primary.to,
            });
            setLastDraftId(created.id);
          });
        }}
      >
        <label>
          主要资料
          <select
            aria-label="主要资料"
            value={material?.id || ""}
            onChange={(e) => {
              const m = materials.find((m) => m.id === e.target.value)!;
              setPrimary(initialPrimary(m));
            }}
          >
            {!material && <option value="">选择资料</option>}
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.pages.length} 页
              </option>
            ))}
          </select>
        </label>
        <div className="chapter-primary-range">
          <label>
            作为
            <RoleSelect
              label="主要资料角色"
              role={primary.role}
              onChange={(role) =>
                setPrimary(
                  primary.usingDefaultPages
                    ? initialPrimary(material, role)
                    : { ...primary, role },
                )
              }
            />
          </label>
          <div>
            <div className="field-caption">整章范围</div>
            <PageRange
              label="骨架范围"
              min={1}
              max={material?.pages.length || 1}
              value={primary}
              onChange={(r) =>
                setPrimary({ ...primary, ...r, usingDefaultPages: false })
              }
            />
          </div>
        </div>
        <div>
          <button
            type="submit"
            className="secondary"
            disabled={
              busy ||
              !material ||
              !validRange(primary, 1, material.pages.length) ||
              (!!task && isPending(task))
            }
          >
            生成骨架预览
          </button>
        </div>
      </form>
      {matches.length > 1 && (
        <label className="chapter-draft-history">
          本范围的预览
          <select
            aria-label="本范围的预览"
            value={task.id}
            onChange={(e) => setLastDraftId(e.target.value)}
          >
            {matches.map((t, i) => (
              <option key={t.id} value={t.id}>
                第 {matches.length - i} 次 ·{" "}
                {new Date(t.createdAt).toLocaleString()} ·{" "}
                {chapterTaskStatus(t)}
              </option>
            ))}
          </select>
        </label>
      )}
      {task && <TaskStatus task={task} onRun={onRun} />}
      {task?.state === "succeeded" && Array.isArray(task.result?.sections) && (
        <OutlinePreview
          key={task.id}
          {...{ task, notebook, primary, drafts, busy, onRun, onApplied }}
        />
      )}
    </>
  );
}

function SupplementForm({
  s,
  notebook,
  materials,
  lesson,
  selected,
  drafts,
  busy,
  onRun,
  onSelectTranscript,
  tasks,
}: {
  s: Obj;
  notebook: Obj;
  materials: Obj[];
  lesson?: Obj;
  selected: string[];
  drafts: ChapterDrafts;
  busy: boolean;
  onRun: Run;
  onSelectTranscript: () => void;
  tasks: Obj[];
}) {
  const [batch, setBatch] = useDraft<Batch>(
    drafts,
    "batch:" + notebook.id + ":" + (lesson?.id || "course"),
    {
      materials: [],
      lessonId: "",
      uids: [],
      useSelected: true,
      targetId: "",
      prompt: "",
    },
  );
  const update = (patch: Partial<Batch>) => setBatch({ ...batch, ...patch });
  const [receipt, setReceipt] = useState("");
  const recent = tasks.filter((t: Obj) => t.supplement);
  const noteTopics = s.topics.filter((t: Obj) => t.noteId === notebook.id);
  const rows = notebookRows(
    noteTopics.filter((t: Obj) => notebook.outline.topicIds.includes(t.id)),
    notebook,
  );
  const lessons = s.lessons.filter(
    (l: Obj) => !l.deleted && l.courseId === notebook.courseId,
  );
  const courseLesson = lessons.find((l: Obj) => l.id === batch.lessonId);
  const sourceLesson = lesson || courseLesson;
  const items = sourceLesson
    ? s.utterances.filter((u: Obj) => u.lessonId === sourceLesson.id)
    : [];
  const available = new Set(
    items.filter((u: Obj) => u.final).map((u: Obj) => u.id),
  );
  const uids = (
    lesson ? (batch.useSelected ? selected : []) : batch.uids
  ).filter((id) => available.has(id));
  const target = rows.some(({ item }) => item.id === batch.targetId)
    ? batch.targetId
    : "";
  const valid = batch.materials.every((r) =>
    validRange(r, 1, materials.find((m) => m.id === r.id)?.pages.length || 0),
  );
  function editRange(id: string, changes: Partial<MaterialRange>) {
    update({
      materials: batch.materials.map((r) =>
        r.id === id ? { ...r, ...changes } : r,
      ),
    });
  }
  const candidates = s.candidates.filter(
    (c: Obj) =>
      c.kind === "append" &&
      c.status === "pending" &&
      noteTopics.some((t: Obj) => t.id === c.topicId),
  );
  return (
    <>
      <form
        className="chapter-fields"
        onSubmit={(e) => {
          e.preventDefault();
          setReceipt("");
          void onRun(async () => {
            const task = await invoke("notebook.supplement", {
              courseId: notebook.courseId,
              noteId: notebook.id,
              materials: batch.materials,
              ...(sourceLesson && (lesson || uids.length)
                ? { lessonId: sourceLesson.id }
                : {}),
              ...(uids.length ? { uids } : {}),
              ...(target ? { targetId: target } : {}),
              prompt: batch.prompt,
            });
            setReceipt(
              task.duplicate || recent.some((t) => t.id === task.id)
                ? "这批内容已提交，沿用原任务。"
                : "本批补充已提交。",
            );
          });
        }}
      >
        <fieldset className="chapter-sources">
          <legend>本批资料</legend>
          {!materials.length && <p>可在课程空间导入课件或教材。</p>}
          {materials.map((m) => {
            const range = batch.materials.find((r) => r.id === m.id);
            const classSlides = lesson?.context?.slides;
            const selectedPages =
              classSlides?.id === m.id &&
              validRange(classSlides, 1, m.pages.length)
                ? classSlides
                : { from: 1, to: 1 };
            return (
              <div className="chapter-source" key={m.id}>
                <label className="chapter-check">
                  <input
                    type="checkbox"
                    checked={!!range}
                    onChange={() =>
                      update({
                        materials: range
                          ? batch.materials.filter((r) => r.id !== m.id)
                          : [
                              ...batch.materials,
                              {
                                id: m.id,
                                role: materialRole(m),
                                from: selectedPages.from,
                                to: selectedPages.to,
                              },
                            ],
                      })
                    }
                  />
                  {m.name} <small>共 {m.pages.length} 页</small>
                </label>
                {range && (
                  <div className="chapter-source-range">
                    <RoleSelect
                      label={m.name + "补充角色"}
                      role={range.role}
                      onChange={(role) => editRange(m.id, { role })}
                    />
                    <PageRange
                      label={m.name + "补充"}
                      value={range}
                      min={1}
                      max={m.pages.length}
                      onChange={(r) => editRange(m.id, r)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
        <fieldset className="chapter-sources">
          <legend>本批转录</legend>
          {lesson ? (
            <div className="chapter-source">
              <label className="chapter-check">
                <input
                  type="checkbox"
                  checked={batch.useSelected && selected.length > 0}
                  disabled={!selected.length}
                  onChange={(e) => update({ useSelected: e.target.checked })}
                />
                使用转录页选中的 {selected.length} 段
              </label>
              <button type="button" onClick={onSelectTranscript}>
                去转录页选择
              </button>
            </div>
          ) : (
            <>
              <label>
                来源课堂
                <select
                  aria-label="来源课堂"
                  value={courseLesson?.id || ""}
                  onChange={(e) =>
                    update({ lessonId: e.target.value, uids: [] })
                  }
                >
                  <option value="">仅使用资料</option>
                  {lessons.map((l: Obj) => (
                    <option key={l.id} value={l.id}>
                      {l.name} · {new Date(l.startedAt).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              </label>
              {courseLesson && (
                <CourseTranscriptSelection
                  key={courseLesson.id}
                  items={items}
                  uids={batch.uids}
                  onChange={(uids) => update({ uids })}
                />
              )}
            </>
          )}
        </fieldset>
        <label>
          目标章节
          <select
            aria-label="目标章节"
            value={target}
            onChange={(e) => update({ targetId: e.target.value })}
          >
            <option value="">按内容匹配已有章节</option>
            {rows.map(({ item, parents }) => (
              <option value={item.id} key={item.id}>
                {[...parents, item].map((s) => s.title).join(" › ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          本批整理要求（可选）
          <textarea
            rows={2}
            value={batch.prompt}
            maxLength={4000}
            onChange={(e) => update({ prompt: e.target.value })}
          />
        </label>
        <div className="row between">
          <small>
            已选 {batch.materials.length} 份资料 · {uids.length} 段转录
          </small>
          <button
            className="primary"
            type="submit"
            disabled={
              busy || !valid || (!batch.materials.length && !uids.length)
            }
          >
            提交本批补充
          </button>
        </div>
      </form>
      {receipt && (
        <p role="status" className="chapter-receipt">
          {receipt}
        </p>
      )}
      {recent.length > 0 && (
        <details className="chapter-history" open>
          <summary>补充记录 · {recent.length} 批</summary>
          {recent.map((t: Obj) => (
            <div key={t.id} className="chapter-history-item">
              <small>
                {new Date(t.createdAt).toLocaleString()} ·{" "}
                {s.lessons.find((l: Obj) => l.id === t.lessonId)?.name ||
                  "课程资料"}
              </small>
              <TaskStatus task={t} onRun={onRun} />
              {(t.noMatch || t.result?.noMatch) && (
                <small>本批没有可追加内容。可调整资料范围或目标章节。</small>
              )}
            </div>
          ))}
        </details>
      )}
      {candidates.length > 0 && (
        <div className="chapter-history">
          <h3>待确认的补充 · {candidates.length} 条</h3>
          {candidates.map((c: Obj) => {
            const topic = noteTopics.find((t: Obj) => t.id === c.topicId);
            return (
              <details key={c.id} className="chapter-review">
                <summary>{topic.title} · 查看追加内容</summary>
                <CandidateReview topic={topic} candidate={c} onRun={onRun} />
              </details>
            );
          })}
        </div>
      )}
    </>
  );
}

export function ChapterWorkflow({
  s,
  notebook,
  lesson,
  selected,
  drafts,
  busy,
  onRun,
  onSelectTranscript,
}: {
  s: Obj;
  notebook: Obj;
  lesson?: Obj;
  selected: string[];
  drafts: ChapterDrafts;
  busy: boolean;
  onRun: Run;
  onSelectTranscript: () => void;
}) {
  const materials = s.materials.filter(
    (m: Obj) =>
      m.courseId === notebook.courseId &&
      m.pages?.length &&
      (!m.kind || m.kind === "book" || m.kind === "slides") &&
      m.ext !== ".srt",
  );
  const tasks: Obj[] = s.tasks
    .filter(
      (t: Obj) => t.noteId === notebook.id && t.courseId === notebook.courseId,
    )
    .reverse();
  const [stage, setStage] = useState(
    notebook.outline ? "supplement" : "outline",
  );
  const outline = notebook.outline;
  const source =
    outline && materials.find((m: Obj) => m.id === outline.materialId);
  return (
    <div className="chapter-workflow">
      <h3>{notebook.name}</h3>
      {outline ? (
        <p className="chapter-binding">
          已确认 {outline.topicIds.length} 个章节 · {roleLabel(outline.role)}《
          {source?.name || "主要资料"}》{pagesLabel(outline.from, outline.to)}
        </p>
      ) : (
        <p className="help">
          选择一章课件或教材，预览章节后可将骨架写入这份笔记。
        </p>
      )}
      <nav className="chapter-stages" aria-label="章节笔记步骤">
        <button
          aria-pressed={stage === "outline"}
          onClick={() => setStage("outline")}
        >
          章节骨架
        </button>
        <button
          disabled={!outline}
          aria-pressed={stage === "supplement"}
          onClick={() => setStage("supplement")}
        >
          分批补充
        </button>
      </nav>
      {stage === "outline" || !outline ? (
        <OutlineForm
          {...{ tasks, notebook, materials, drafts, busy, onRun }}
          onApplied={() => setStage("supplement")}
        />
      ) : (
        <SupplementForm
          {...{
            s,
            notebook,
            materials,
            lesson,
            selected,
            drafts,
            busy,
            onRun,
            tasks,
            onSelectTranscript,
          }}
        />
      )}
    </div>
  );
}
