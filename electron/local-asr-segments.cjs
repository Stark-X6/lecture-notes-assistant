// Audio is persisted in small files, while recognition consumes contiguous phrases.
function plan(chunks, ranges, maxMs = 20000) {
  const gaps = [];
  for (const c of [...chunks].sort((a, b) => a.startMs - b.startMs)) {
    let parts = [{ start: c.startMs, end: c.endMs }];
    for (const r of ranges)
      parts = parts.flatMap((g) =>
        r.endMs <= g.start || r.startMs >= g.end
          ? [g]
          : [
              { start: g.start, end: Math.min(g.end, r.startMs) },
              { start: Math.max(g.start, r.endMs), end: g.end },
            ].filter((p) => p.end - p.start > 0.5),
      );
    for (const g of parts) gaps.push({ ...g, chunk: c });
  }
  const parts = [];
  let duration = 0,
    last;
  for (const g of gaps) {
    if (last != null && Math.abs(g.start - last) > 2) break;
    const end = Math.min(g.end, g.start + maxMs - duration);
    parts.push({ ...g, end });
    duration += end - g.start;
    last = end;
    if (duration >= maxMs) break;
  }
  return { parts, duration };
}
function consume(parts, ms) {
  const used = [];
  for (const p of parts) {
    if (ms <= 0) break;
    const duration = Math.min(ms, p.end - p.start);
    used.push({ ...p, end: p.start + duration });
    ms -= duration;
  }
  return used;
}
module.exports = { plan, consume };
