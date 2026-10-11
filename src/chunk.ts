/** Sentence-aware chunker: packs sentences into chunks of at most MAX_WORDS. */

export const MAX_WORDS = 550;
/** Soft target — leaves headroom so validate() page counts stay in quota. */
export const TARGET_WORDS = 450;

export interface Chunk {
  index: number;
  text: string;
  words: number;
}

const SENT_END = /(?<=[.!?…\"”'’)\]])\s+(?=[A-Z0-9"“"(\[])/g;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(SENT_END)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function countWords(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

/** Greedy pack; a single over-long sentence becomes its own chunk (capped). */
export function chunkText(text: string, maxWords = MAX_WORDS): Chunk[] {
  const sentences = splitSentences(text);
  const chunks: Chunk[] = [];
  let cur: string[] = [];
  let curWords = 0;
  const flush = () => {
    if (cur.length === 0) return;
    const t = cur.join(" ");
    chunks.push({ index: chunks.length, text: t, words: countWords(t) });
    cur = [];
    curWords = 0;
  };
  for (const s of sentences) {
    const w = countWords(s);
    if (w >= maxWords) {
      flush();
      // hard-split pathological single sentence on word boundary
      const words = s.split(/\s+/);
      for (let i = 0; i < words.length; i += maxWords) {
        const t = words.slice(i, i + maxWords).join(" ");
        chunks.push({ index: chunks.length, text: t, words: countWords(t) });
      }
      continue;
    }
    // never exceed MAX; prefer breaks at/after TARGET on sentence ends
    if (curWords + w > maxWords || curWords >= TARGET_WORDS) flush();
    cur.push(s);
    curWords += w;
  }
  flush();
  // A trailing stub (<100 words) would fail site validation — fold it into
  // the previous chunk. May push that chunk past MAX in pathological cases,
  // but that beats a guaranteed-rejected stub.
  const MIN_WORDS = 100;
  while (chunks.length > 1 && chunks[chunks.length - 1].words < MIN_WORDS) {
    const stub = chunks.pop()!;
    const prev = chunks[chunks.length - 1];
    prev.text = `${prev.text} ${stub.text}`;
    prev.words = countWords(prev.text);
  }
  // re-index (merge changed order/count)
  chunks.forEach((c, i) => (c.index = i));
  return chunks;
}
