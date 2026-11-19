const BOOK_PAGE_LIMIT = 18;
const BOOK_EXCERPT_CHARS = 2300;

function keywords(text) {
  const words = new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []);
  for (const phrase of text.match(/\p{Script=Han}{2,}/gu) || [])
    for (let i = 0; i < phrase.length - 1; i++)
      words.add(phrase.slice(i, i + 2));
  return words;
}

function relevant(pages, queries, limit) {
  const index = new Map();
  for (const page of pages)
    for (const word of keywords(page.text)) {
      if (!index.has(word)) index.set(word, []);
      index.get(word).push(page);
    }
  const scores = new Map();
  for (const query of queries) {
    const matches = new Map();
    for (const word of keywords(query)) {
      const relevantPages = index.get(word);
      if (!relevantPages) continue;
      const weight = 1 / Math.sqrt(relevantPages.length);
      for (const page of relevantPages) {
        if (!matches.has(page)) matches.set(page, { page, score: 0, hits: 0 });
        const match = matches.get(page);
        match.hits += /^[a-z]/.test(word) ? 2 : 1;
        match.score += weight;
      }
    }
    const ranked = [...matches.values()]
      .filter((x) => x.hits >= 2)
      .sort((a, b) => b.score - a.score || a.page.page - b.page.page);
    for (const { page, score } of ranked.slice(0, Math.min(3, limit))) {
      if (score < ranked[0].score * 0.4) continue;
      scores.set(page, Math.max(scores.get(page) || 0, score));
    }
  }
  return [...scores.entries()]
    .sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.page - b.page)
    .slice(0, limit)
    .map(([page]) => page)
    .sort((a, b) => a.page - b.page);
}

function pageRefs(material, role, from = 1, to = material.pages.length) {
  return material.pages.slice(from - 1, to).map((body, index) => {
    const page = index + from;
    return {
      id: `p:${material.id}:${page}:${material.sha}`,
      version: material.sha,
      kind: "material",
      materialRole: role,
      targetId: material.id,
      page,
      name: material.name,
      text: body,
    };
  });
}

function outlineForPages(material, pages) {
  const matched = [];
  for (const node of material?.outline || []) {
    const selected = pages.filter(
      (page) => page >= node.from && page <= node.to,
    );
    if (!selected.length) continue;
    matched.push({ title: node.title, pages: selected });
  }
  return matched.sort(
    (a, b) => a.pages[0] - b.pages[0] || a.pages.length - b.pages.length,
  );
}

function scopedBatch(input, sources) {
  const slides = sources.filter((s) => s.materialRole === "slides");
  const selected = input.sources.filter((s) => s.materialRole === "slides");
  if (!slides.length && selected.length) {
    const matches = relevant(
      selected,
      [sources.map((s) => s.text).join(" ")],
      6,
    );
    for (const slide of matches.length ? matches : selected.slice(0, 4))
      sources.push({ ...slide, text: slide.text.slice(0, 1300) });
  }
  const queries = sources
    .filter((s) => s.materialRole === "slides")
    .map((s) => s.text);
  const book = input.sources.filter((s) => s.materialRole === "book");
  if (book.length <= 6) return [...sources, ...book];
  const matches = relevant(
    book,
    queries.length ? queries : [sources.map((s) => s.text).join(" ")],
    6,
  );
  return [...sources, ...matches];
}

function position(block, input) {
  const refs = input.sources.filter((source) =>
    block.source_ids.includes(source.id),
  );
  for (const role of [input.noteScope.order, "slides"]) {
    const first = refs
      .filter((r) => r.materialRole === role)
      .sort((a, b) => a.page - b.page)[0];
    if (first)
      return {
        materialId: first.targetId,
        page: first.page,
        fallback: role !== input.noteScope.order,
      };
  }
  return { page: Infinity, fallback: true };
}

function structureForSources(input, sources) {
  if (!input.noteScope) return input.structure;
  const pages = new Set(
    sources
      .filter((s) => s.materialRole === input.noteScope.order)
      .map((s) => s.page),
  );
  return input.structure.flatMap((node) => {
    const selected = node.pages.filter((p) => pages.has(p));
    return selected.length ? [{ ...node, pages: selected }] : [];
  });
}

module.exports = {
  BOOK_PAGE_LIMIT,
  BOOK_EXCERPT_CHARS,
  pageRefs,
  relevant,
  outlineForPages,
  scopedBatch,
  position,
  structureForSources,
};
