export type TranscriptRow = {
  id: string;
  text: string;
  startMs: number | null;
  endMs?: number | null;
  final?: boolean;
  topicId?: string | null;
  needsReview?: boolean;
  reviewReason?: string | null;
  createdAt?: number;
};

export function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(":");
  if (!parts.length || parts.length > 3) return null;
  if (
    !parts.every((part, index) =>
      index === parts.length - 1
        ? /^\d+(?:\.\d{1,3})?$/.test(part)
        : /^\d+$/.test(part),
    )
  )
    return null;
  const values = parts.map(Number);
  if (parts.length > 1 && values.at(-1)! >= 60) return null;
  if (parts.length === 3 && values[1] >= 60) return null;
  const ms = Math.round(
    values.reduce((seconds, part) => seconds * 60 + part, 0) * 1000,
  );
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

export function formatTimestamp(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor(value / 60000) % 60;
  const seconds = Math.floor(value / 1000) % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    (hours ? `${hours}:${pad(minutes)}` : pad(minutes)) +
    `:${pad(seconds)}` +
    (value % 1000 ? `.${String(value % 1000).padStart(3, "0")}` : "")
  );
}

export function selectTimeRange(
  items: TranscriptRow[],
  from: number,
  to: number,
): string[] {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from
  )
    throw new Error(
      "结束时间必须晚于开始时间，请使用 05:00 或 1:05:00 的格式。",
    );
  return items
    .filter((item) => {
      if (
        item.final !== true ||
        typeof item.startMs !== "number" ||
        !Number.isFinite(item.startMs)
      )
        return false;
      const end =
        typeof item.endMs === "number" && Number.isFinite(item.endMs)
          ? Math.max(item.endMs, item.startMs + 1)
          : item.startMs + 1;
      return item.startMs < to && end > from;
    })
    .map((item) => item.id);
}

export function selectParagraphRange(
  items: TranscriptRow[],
  from: number,
  to: number,
): string[] {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to < from ||
    to > items.length
  )
    throw new Error(
      `段落范围应在 1–${items.length} 内，结束段落不能早于起始段落。`,
    );
  return items
    .slice(from - 1, to)
    .filter((item) => item.final === true)
    .map((item) => item.id);
}

export type TranscriptGroup = {
  id: string;
  bucket: number | null;
  topicId: string;
  startMs: number | null;
  endMs: number | null;
  characters: number;
  items: TranscriptRow[];
};
export function groupTranscript(items: TranscriptRow[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const item of items) {
    const start =
      typeof item.startMs === "number" && Number.isFinite(item.startMs)
        ? item.startMs
        : null;
    const bucket = start === null ? null : Math.floor(start / 60000);
    const topicId = item.topicId || "";
    let last = groups.at(-1);
    if (
      !last ||
      last.bucket !== bucket ||
      last.topicId !== topicId ||
      last.characters + item.text.length > 1600 ||
      last.items.length >= 16
    ) {
      last = {
        id: item.id,
        bucket,
        topicId,
        startMs: start,
        endMs: start,
        characters: 0,
        items: [],
      };
      groups.push(last);
    }
    last.items.push(item);
    last.characters += item.text.length;
    if (start !== null)
      last.endMs = Math.max(last.endMs || 0, item.endMs ?? start);
  }
  return groups;
}
