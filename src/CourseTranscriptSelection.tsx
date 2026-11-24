import { useState } from "react";
import {
  formatTimestamp,
  parseTimestamp,
  selectParagraphRange,
  selectTimeRange,
  type TranscriptRow,
} from "./transcriptSelection";

export function CourseTranscriptSelection({
  items,
  uids,
  onChange,
}: {
  items: TranscriptRow[];
  uids: string[];
  onChange: (ids: string[]) => void;
}) {
  const timed = items.some((u) => u.final && typeof u.startMs === "number");
  const end = items.reduce(
    (max, u) =>
      u.final && typeof u.startMs === "number"
        ? Math.max(max, u.endMs ?? 0, u.startMs + 1)
        : max,
    0,
  );
  const [mode, setMode] = useState(timed ? "time" : "paragraph");
  const [times, setTimes] = useState({
    from: "00:00",
    to: formatTimestamp(end),
  });
  const [paragraphs, setParagraphs] = useState({
    from: "1",
    to: String(items.length),
  });
  const [error, setError] = useState("");
  const selected = new Set(uids);
  if (!items.some((u) => u.final)) return <p>这次课堂还没有定稿转录。</p>;
  function applyRange() {
    try {
      let ids: string[];
      if (mode === "time") {
        const start = parseTimestamp(times.from),
          finish = parseTimestamp(times.to);
        if (start === null || finish === null)
          throw new Error("请输入有效起止时间，例如 05:00。");
        ids = selectTimeRange(items, start, finish);
      } else
        ids = selectParagraphRange(
          items,
          Number(paragraphs.from),
          Number(paragraphs.to),
        );
      if (!ids.length) throw new Error("这段范围没有定稿转录，请调整选区。");
      onChange(ids);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <details className="historical-range">
        <summary>按时间或段落选择</summary>
        <div className="chapter-range">
          <select
            aria-label="历史转录选区方式"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setError("");
            }}
          >
            <option value="time" disabled={!timed}>
              时间段
            </option>
            <option value="paragraph">原始段落</option>
          </select>
          {mode === "time" ? (
            <>
              <input
                aria-label="历史转录开始时间"
                value={times.from}
                onChange={(e) => setTimes({ ...times, from: e.target.value })}
              />
              至
              <input
                aria-label="历史转录结束时间"
                value={times.to}
                onChange={(e) => setTimes({ ...times, to: e.target.value })}
              />
            </>
          ) : (
            <>
              <input
                type="number"
                min={1}
                max={items.length}
                aria-label="历史转录起始段落"
                value={paragraphs.from}
                onChange={(e) =>
                  setParagraphs({ ...paragraphs, from: e.target.value })
                }
              />
              至
              <input
                type="number"
                min={1}
                max={items.length}
                aria-label="历史转录结束段落"
                value={paragraphs.to}
                onChange={(e) =>
                  setParagraphs({ ...paragraphs, to: e.target.value })
                }
              />
            </>
          )}
          <button
            type="button"
            className="secondary compact"
            onClick={applyRange}
          >
            选中该范围
          </button>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </details>
      <div className="chapter-utterances">
        {items.map((u, i) => (
          <label className="chapter-check" key={u.id}>
            <input
              type="checkbox"
              disabled={!u.final}
              checked={selected.has(u.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...uids, u.id]
                    : uids.filter((id) => id !== u.id),
                )
              }
            />
            <span>
              <small>
                {typeof u.startMs === "number"
                  ? formatTimestamp(u.startMs)
                  : `第 ${i + 1} 段`}
              </small>{" "}
              {u.text}
            </span>
          </label>
        ))}
      </div>
    </>
  );
}
