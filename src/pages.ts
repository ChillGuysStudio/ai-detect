/** Page specs like "1,3,5-7" (1-based, inclusive). Used by CLI flags,
 *  POST /api/jobs {pages}, and the PDF overview UI.
 */

/** Parse "1,3,5-7" into sorted unique 0-based indices, clamped to [0, total). */
export function parsePages(spec: string | undefined, total: number): number[] {
  if (!spec || !spec.trim() || spec.trim().toLowerCase() === "all") {
    return Array.from({ length: total }, (_, i) => i);
  }
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) out.add(n - 1);
    } else if (/^\d+$/.test(p)) {
      out.add(parseInt(p, 10) - 1);
    } else {
      throw new Error(`bad page spec part: "${p}" (want like "1,3,5-7")`);
    }
  }
  const idx = [...out].filter((i) => i >= 0 && i < total).sort((a, b) => a - b);
  if (idx.length === 0) throw new Error(`page spec "${spec}" selects no pages (doc has ${total})`);
  return idx;
}

/** Remove 1-based pages in excludeSpec from an index list. */
export function excludePages(idx: number[], excludeSpec: string | undefined, total: number): number[] {
  if (!excludeSpec?.trim()) return idx;
  const drop = new Set(parsePages(excludeSpec, total));
  const kept = idx.filter((i) => !drop.has(i));
  if (kept.length === 0) throw new Error(`exclusions remove every page`);
  return kept;
}

/** 0-based indices back to compact "1,3,5-7" for display/echo. */
export function formatPages(idx: number[]): string {
  if (idx.length === 0) return "";
  const s = [...idx].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = s[0];
  let prev = s[0];
  for (const n of s.slice(1)) {
    if (n === prev + 1) {
      prev = n;
    } else {
      ranges.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
      start = prev = n;
    }
  }
  ranges.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
  return ranges.join(",");
}
