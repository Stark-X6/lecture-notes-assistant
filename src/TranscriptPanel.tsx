import { createPortal } from "react-dom";
import { useEffect, useMemo, useState, useRef, useLayoutEffect } from "react";
import {
  Upload,
  Plus,
  Search,
  FileText,
  Volume2,
  ChevronDown,
  Clock3,
  X,
} from "lucide-react";
import {
  formatTimestamp,
  groupTranscript,
  parseTimestamp,
  selectParagraphRange,
  selectTimeRange,
  type TranscriptRow,
} from "./transcriptSelection";

type Props = {
  items: TranscriptRow[];
  topics: Record<string, any>[];
  selected: string[];
  onSelected: (ids: string[]) => void;
  onAssign: () => void;
  onImport: () => void;
  onManual: () => void;
  onPlay: (item: TranscriptRow) => void;
  onRevise: (item: TranscriptRow) => void;
  stateOf: (item: TranscriptRow) => string;
  focusSource: string;
  captureActive: boolean;
  waiting: boolean;
  partial: string;
  hint: string;
  onHint: (value: string) => void;
  busy: boolean;
  paused: boolean;
  automatic: boolean;
  onSubmit: () => void;
};
export function TranscriptPanel(p: Props) {
  const timed = p.items.some(
    (item) => item.final && typeof item.startMs === "number",
  );
  const end = p.items.reduce(
    (maximum, item) =>
      item.final && typeof item.startMs === "number"
        ? Math.max(maximum, item.endMs ?? item.startMs + 1, item.startMs + 1)
        : maximum,
    0,
  );
  const [mode, setMode] = useState(timed ? "time" : "paragraph");
  const [rangeOpen, setRangeOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLDivElement>(null);
  const rangeButton = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 16, width: 420 });
  useEffect(() => {
    if (!rangeOpen) return;
    const close = (event: PointerEvent) => {
      if (
        !toolsRef.current?.contains(event.target as Node) &&
        !rangeRef.current?.contains(event.target as Node)
      )
        setRangeOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [rangeOpen]);
  const [editedRange, setEditedRange] = useState(false);
  const [from, setFrom] = useState("00:00"),
    [to, setTo] = useState(formatTimestamp(end));
  const [first, setFirst] = useState("1"),
    [last, setLast] = useState(String(p.items.length || 1));
  const [search, setSearch] = useState(""),
    [error, setError] = useState("");
  const [applied, setApplied] = useState(""),
    [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (p.focusSource && p.items.some((item) => item.id === p.focusSource)) {
      setSearch("");
      const frame = requestAnimationFrame(() =>
        document
          .getElementById(p.focusSource)
          ?.scrollIntoView({ block: "center" }),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [p.focusSource]);
  useEffect(() => {
    if (!editedRange) {
      setTo(formatTimestamp(end));
      setLast(String(p.items.length || 1));
    }
  }, [end, p.items.length, editedRange]);
  // Imports/live finalization can add the first timestamp after this pane mounts.
  useEffect(() => {
    if (timed) setMode("time");
  }, [timed]);
  const filtered = useMemo(
    () =>
      [...p.items]
        .sort(
          (a, b) =>
            (a.startMs ?? Infinity) - (b.startMs ?? Infinity) ||
            (a.createdAt || 0) - (b.createdAt || 0),
        )
        .filter((item) => item.text.includes(search)),
    [p.items, search],
  );
  const groups = useMemo(() => groupTranscript(filtered), [filtered]);
  const selected = new Set(p.selected),
    visible = new Set(filtered.map((item) => item.id));
  const hiddenSelected = p.selected.filter((id) => !visible.has(id)).length;
  const originalNumber = new Map(
    p.items.map((item, index) => [item.id, index + 1]),
  );
  const pending = p.items.filter(
    (item) => item.final && p.stateOf(item) !== "已整理",
  ).length;
  useLayoutEffect(() => {
    if (!rangeOpen) return;
    const place = () => {
      const rect = rangeButton.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(430, window.innerWidth - 24);
      const height = rangeRef.current?.offsetHeight || 160;
      const left = Math.max(
        12,
        Math.min(rect.right - width, window.innerWidth - width - 12),
      );
      const below = rect.bottom + 7;
      const top =
        below + height <= window.innerHeight - 12
          ? below
          : Math.max(12, rect.top - height - 7);
      setPosition({ left, top, width });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [rangeOpen, error, mode]);
  function chooseRange() {
    try {
      let ids: string[];
      if (mode === "time") {
        const start = parseTimestamp(from),
          finish = parseTimestamp(to);
        if (start === null || finish === null)
          throw new Error("请输入有效时间，例如 05:00 或 1:05:00。");
        ids = selectTimeRange(p.items, start, finish);
        if (!ids.length)
          throw new Error("这个时间段没有定稿转录，请调整范围。");
        setApplied(`${formatTimestamp(start)}–${formatTimestamp(finish)}`);
      } else {
        ids = selectParagraphRange(p.items, Number(first), Number(last));
        if (!ids.length) throw new Error("这个段落范围没有定稿转录。");
        setApplied(`原始第 ${first}–${last} 段`);
      }
      p.onSelected(ids);
      setRangeOpen(false);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function chooseAll() {
    p.onSelected(
      p.items.filter((item) => item.final === true).map((item) => item.id),
    );
    setFrom("00:00");
    setTo(formatTimestamp(end));
    setFirst("1");
    setLast(String(p.items.length));
    setApplied("全部定稿转录");
    setEditedRange(true);
    setRangeOpen(false);
    setError("");
  }
  function selectGroup(items: TranscriptRow[]) {
    p.onSelected(
      items.filter((item) => item.final === true).map((item) => item.id),
    );
    setApplied("阅读段落");
    setError("");
  }
  return (
    <section className="panel transcript-panel">
      <div className="panel-header">
        <div className="panel-title">
          <Clock3 size={17} />
          <h2>课堂转录</h2>
          <span className="count">{p.items.length} 段</span>
          {p.partial && <span className="listening">转写中</span>}
        </div>
        <div className="row gap6">
          <button className="text-button" onClick={p.onImport}>
            <Upload size={14} />
            导入
          </button>
          <button
            className="icon-btn"
            title="手动输入转录"
            onClick={p.onManual}
          >
            <Plus size={17} />
          </button>
        </div>
      </div>
      {p.items.length > 0 && (
        <div className="transcript-tools" ref={toolsRef}>
          <div className="transcript-search">
            <Search size={14} />
            <input
              placeholder="搜索课堂内容…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            className="range-toggle"
            ref={rangeButton}
            aria-expanded={rangeOpen}
            aria-controls="transcript-range-editor"
            onClick={() => setRangeOpen(!rangeOpen)}
          >
            <Clock3 size={14} />
            {timed ? "选择时间段" : "选择段落范围"}
            <ChevronDown size={13} />
          </button>
          {rangeOpen &&
            createPortal(
              <div
                className="range-editor"
                ref={rangeRef}
                style={position}
                id="transcript-range-editor"
                role="group"
                aria-label="选择转录范围"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRangeOpen(false);
                }}
              >
                <div className="range-mode" aria-label="转录选择方式">
                  <button
                    className={mode === "time" ? "selected" : ""}
                    disabled={!timed}
                    onClick={() => {
                      setMode("time");
                      setError("");
                    }}
                  >
                    按时间
                  </button>
                  <button
                    className={mode === "paragraph" ? "selected" : ""}
                    onClick={() => {
                      setMode("paragraph");
                      setError("");
                    }}
                  >
                    按段落
                  </button>
                  <button className="text-button" onClick={chooseAll}>
                    选择全部转录
                  </button>
                </div>
                <div className="transcript-range">
                  {mode === "time" ? (
                    <>
                      <label>
                        开始
                        <input
                          aria-label="开始时间"
                          value={from}
                          placeholder="00:00"
                          onChange={(e) => {
                            setFrom(e.target.value);
                            setEditedRange(true);
                          }}
                        />
                      </label>
                      <span className="range-dash">至</span>
                      <label>
                        结束
                        <input
                          aria-label="结束时间"
                          value={to}
                          placeholder={formatTimestamp(end)}
                          onChange={(e) => {
                            setTo(e.target.value);
                            setEditedRange(true);
                          }}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label>
                        第
                        <input
                          type="number"
                          min={1}
                          max={p.items.length}
                          aria-label="起始段落"
                          value={first}
                          onChange={(e) => {
                            setFirst(e.target.value);
                            setEditedRange(true);
                          }}
                        />
                      </label>
                      <span className="range-dash">至</span>
                      <label>
                        第
                        <input
                          type="number"
                          min={1}
                          max={p.items.length}
                          aria-label="结束段落"
                          value={last}
                          onChange={(e) => {
                            setLast(e.target.value);
                            setEditedRange(true);
                          }}
                        />
                      </label>
                      <span>段</span>
                    </>
                  )}
                  <button className="range-apply" onClick={chooseRange}>
                    选择范围
                  </button>
                </div>
                {error ? (
                  <p className="range-error" role="alert">
                    {error}
                  </p>
                ) : (
                  <p className="range-help">
                    {mode === "time"
                      ? "选择与时间段重叠的完整句子。"
                      : "按原始导入顺序编号；未定稿内容不计入选择。"}
                    {!timed && "此文件没有时间戳。"}
                  </p>
                )}
              </div>,
              document.body,
            )}
          {p.selected.length > 0 && (
            <div className="range-selection">
              <span>
                已选 {p.selected.length} 段{applied && <small>{applied}</small>}
                {hiddenSelected > 0 && (
                  <small>其中 {hiddenSelected} 段不在当前搜索结果中</small>
                )}
              </span>
              <button
                onClick={() => {
                  setRangeOpen(false);
                  p.onAssign();
                }}
              >
                归入主题 ({p.selected.length})
              </button>
              <button
                className="icon-btn"
                title="清除选择"
                onClick={() => {
                  p.onSelected([]);
                  setApplied("");
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      )}
      <div className="transcript-scroll">
        {groups.map((group) => (
          <article className="transcript-group" key={group.id}>
            <div className="transcript-group-meta">
              <span>
                {group.startMs === null
                  ? `第 ${originalNumber.get(group.items[0].id)} 段起`
                  : `${formatTimestamp(group.startMs)}–${formatTimestamp(group.endMs ?? group.startMs)}`}
              </span>
              {group.topicId && (
                <span className="source-tag">
                  {p.topics.find((topic) => topic.id === group.topicId)
                    ?.title || "已归类"}
                </span>
              )}
              {group.items.some((item) => item.needsReview) && (
                <span className="review-flag">待回听核对</span>
              )}
              <span className="group-actions">
                <button onClick={() => selectGroup(group.items)}>选这段</button>
                {group.startMs !== null && (
                  <button
                    title="回听此处（分片定位）"
                    onClick={() => p.onPlay(group.items[0])}
                  >
                    <Volume2 size={13} />
                  </button>
                )}
                <button
                  aria-expanded={expanded.has(group.id)}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      next.has(group.id)
                        ? next.delete(group.id)
                        : next.add(group.id);
                      return next;
                    })
                  }
                >
                  {expanded.has(group.id) ? "收起逐句" : "逐句查看"}
                  <ChevronDown size={12} />
                </button>
              </span>
            </div>
            {expanded.has(group.id) ? (
              <div className="transcript-sentences">
                {group.items.map((item) => (
                  <div
                    key={item.id}
                    id={item.id}
                    className={
                      "transcript-sentence " +
                      (selected.has(item.id) ? "selected " : "") +
                      (p.focusSource === item.id ? "highlight" : "")
                    }
                  >
                    <div className="sentence-meta">
                      <input
                        type="checkbox"
                        aria-label={`选择转录 ${originalNumber.get(item.id)}`}
                        checked={selected.has(item.id)}
                        disabled={!item.final}
                        onChange={(e) => {
                          p.onSelected(
                            e.target.checked
                              ? [...p.selected, item.id]
                              : p.selected.filter((id) => id !== item.id),
                          );
                          setApplied("手动选择");
                        }}
                      />
                      <span>
                        {item.startMs === null
                          ? `第 ${originalNumber.get(item.id)} 段`
                          : formatTimestamp(item.startMs)}
                      </span>
                      <small>{p.stateOf(item)}</small>
                      {item.startMs !== null && (
                        <button
                          title="回听此处（分片定位）"
                          onClick={() => p.onPlay(item)}
                        >
                          <Volume2 size={13} />
                        </button>
                      )}
                      <button onClick={() => p.onRevise(item)}>纠错</button>
                    </div>
                    {item.needsReview && (
                      <p className="range-error">
                        {item.reviewReason || "请回听核对"}
                      </p>
                    )}
                    <p>{item.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="transcript-paragraph">
                {group.items.map((item) => (
                  <span
                    id={item.id}
                    key={item.id}
                    className={
                      "transcript-fragment " +
                      (selected.has(item.id) ? "selected " : "") +
                      (p.focusSource === item.id ? "highlight" : "")
                    }
                  >
                    {item.text}{" "}
                  </span>
                ))}
              </p>
            )}
          </article>
        ))}
        {!groups.length && p.items.length > 0 && (
          <p className="empty-transcript">
            没有匹配的转录。范围选择仍针对整份转录。
          </p>
        )}
        {!p.items.length && !p.partial && (
          <div className="transcript-empty">
            <FileText size={28} />
            <h3>还没有课堂转录</h3>
            <p>导入 TXT / SRT，或开始录音。</p>
            <button className="secondary" onClick={p.onImport}>
              导入转录文件
            </button>
          </div>
        )}
        {p.partial && (
          <p className="transcript-partial">
            {p.partial}
            <span className="cursor" />
          </p>
        )}
      </div>
      <div className="submit-area">
        <input
          aria-label="笔记整理要求"
          value={p.hint}
          onChange={(e) => p.onHint(e.target.value)}
          placeholder="整理要求，如保留例子、突出老师强调…"
        />
        <div className="submit-bottom">
          <span>
            {p.automatic
              ? "分段整理请切换半自动模式"
              : p.waiting
                ? "等待转写补齐后自动提交"
                : p.captureActive
                  ? "划定当前讲解，转写完成后整理"
                  : `${pending} 段待处理`}
          </span>
          <button
            className="primary transcript-submit"
            disabled={
              p.busy ||
              p.paused ||
              p.automatic ||
              (!p.selected.length && !pending && !p.captureActive)
            }
            onClick={p.onSubmit}
          >
            {p.selected.length
              ? "整理所选内容"
              : p.captureActive
                ? "整理当前讲解"
                : "整理待处理内容"}
          </button>
        </div>
      </div>
    </section>
  );
}
