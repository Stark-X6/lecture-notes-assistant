import type { CSSProperties, ReactNode } from "react";
import { Markdown } from "./Markdown";

type Obj = Record<string, any>;
export type Run = (fn: () => Promise<any>) => Promise<any>;
export type TreeRow<T> = { item: T; parents: T[] };

export function treeRows<T>(
  items: T[],
  key: (item: T) => string,
  parent: (item: T) => string | null,
): TreeRow<T>[] {
  const children = new Map<string | null, T[]>();
  const ids = new Set(items.map(key));
  for (const item of items) {
    const p = parent(item);
    const id = p && ids.has(p) ? p : null;
    const siblings = children.get(id);
    if (siblings) siblings.push(item);
    else children.set(id, [item]);
  }
  const rows: TreeRow<T>[] = [];
  const visited = new Set<string>();
  function visit(item: T, parents: T[]) {
    const id = key(item);
    if (visited.has(id)) return;
    visited.add(id);
    rows.push({ item, parents });
    for (const child of children.get(id) || [])
      visit(child, [...parents, item]);
  }
  for (const item of children.get(null) || []) visit(item, []);
  // Historical notes can have a missing or circular parent. Keep them readable.
  for (const item of items) if (!visited.has(key(item))) visit(item, []);
  return rows;
}

export function notebookRows(topics: Obj[], notebook?: Obj): TreeRow<Obj>[] {
  const ids: string[] = notebook?.outline?.topicIds || [];
  const rank = new Map(ids.map((id, i) => [id, i]));
  const ordered = [...topics].sort(
    (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length),
  );
  return treeRows(
    ordered,
    (t) => t.id,
    (t) => t.parentId || null,
  );
}

export const pagesLabel = (from: number, to: number) =>
  from === to ? `第 ${from} 页` : `第 ${from}–${to} 页`;
export const depthStyle = (depth: number) =>
  ({ "--chapter-depth": Math.min(depth, 5) }) as CSSProperties;

export function SectionHeading({
  row,
  materials,
  level,
  children,
}: {
  row: TreeRow<Obj>;
  materials: Obj[];
  level: number;
  children?: ReactNode;
}) {
  const { item, parents } = row;
  const range = item.outlineRange;
  const material = range && materials.find((m) => m.id === range.materialId);
  const Tag = ("h" + Math.min(6, level + parents.length)) as
    "h3" | "h4" | "h5" | "h6";
  return (
    <header className="chapter-heading" style={depthStyle(parents.length)}>
      {parents.length > 0 && (
        <small className="chapter-path">
          {parents.map((p) => p.title).join(" › ")}
        </small>
      )}
      <Tag>
        {item.title} {children}
      </Tag>
      {range && (
        <small>
          {material?.name || "骨架来源"} · {pagesLabel(range.from, range.to)}
        </small>
      )}
    </header>
  );
}

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

export function CandidateReview({
  candidate,
  topic,
  onRun,
  legacyAction = "采用候选",
}: {
  candidate: Obj;
  topic: Obj;
  onRun: Run;
  legacyAction?: string;
}) {
  const append = candidate.kind === "append";
  const changed = topic.version !== candidate.baseVersion;
  const act = (method: string) =>
    void onRun(() =>
      window.desktop.invoke(method, {
        id: candidate.id,
        version: topic.version,
      }),
    );
  return (
    <>
      <div className="comparison">
        <div>
          <h4>当前笔记 · v{topic.version}</h4>
          <Markdown>{topic.body || "（空白）"}</Markdown>
        </div>
        <div>
          <h4>
            {append ? "本次追加" : "AI 建议"} · 基于 v{candidate.baseVersion}
          </h4>
          <Markdown>{append ? candidate.addition : candidate.body}</Markdown>
          {append && candidate.sources?.length > 0 && (
            <Sources sources={candidate.sources} />
          )}
        </div>
      </div>
      {changed && (
        <p className={append ? "help" : "inline-error"}>
          {append
            ? `确认后将本次补充追加到当前 v${topic.version}。`
            : "当前笔记已更新，请基于最新版本重新生成。"}
        </p>
      )}
      <div className="row end">
        <button className="text-button" onClick={() => act("candidate.reject")}>
          拒绝
        </button>
        <button
          className="primary compact"
          disabled={changed && !append}
          onClick={() => act("candidate.apply")}
        >
          {append ? "确认追加" : legacyAction}
        </button>
      </div>
    </>
  );
}
