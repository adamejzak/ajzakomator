// Small subsequence fuzzy matcher for the command palette.

const isBoundary = (text: string, i: number) => i === 0 || /[\s\-_/\\.:]/.test(text[i - 1]) ||
  (text[i] >= 'A' && text[i] <= 'Z' && text[i - 1] >= 'a' && text[i - 1] <= 'z');

/** Higher is better; null when `query` is not a subsequence of `text`. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += 1;
    if (found === prev + 1) score += 3;
    if (isBoundary(text, found)) score += 4;
    if (found === 0) score += 2;
    score -= Math.min(3, (found - ti) * 0.1);
    prev = found;
    ti = found + 1;
  }
  return score - text.length * 0.01;
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query, getText(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
