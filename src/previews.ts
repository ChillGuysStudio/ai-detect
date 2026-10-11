/** Ephemeral PDF preview store: upload once, thumbnail/zoom per page, job by pages. */
import { pdfPageInfo, renderPagePng } from "./pdf.ts";

export interface Preview {
  id: string;
  name: string;
  bytes: Uint8Array;
  pages: number;
  info: Array<{ page: number; words: number; chars: number }>;
  createdAt: number;
}

const previews = new Map<string, Preview>();
const thumbs = new Map<string, Uint8Array>(); // `${id}:${page}:${dpi}` -> png
const TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEWS = 10;

function sweep() {
  const now = Date.now();
  for (const [id, p] of previews) {
    if (now - p.createdAt > TTL_MS) {
      previews.delete(id);
      for (const k of [...thumbs.keys()]) if (k.startsWith(id + ":")) thumbs.delete(k);
    }
  }
  while (previews.size > MAX_PREVIEWS) {
    const oldest = [...previews.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    previews.delete(oldest[0]);
  }
}

export async function createPreview(name: string, bytes: Uint8Array): Promise<Preview> {
  sweep();
  const { pages, info } = await pdfPageInfo(bytes);
  const p: Preview = { id: crypto.randomUUID(), name, bytes, pages, info, createdAt: Date.now() };
  previews.set(p.id, p);
  return p;
}

export function getPreview(id: string): Preview | undefined {
  const p = previews.get(id);
  if (p && Date.now() - p.createdAt > TTL_MS) {
    previews.delete(id);
    return undefined;
  }
  return p;
}

export async function pagePng(id: string, page1: number, dpi: number): Promise<Uint8Array> {
  const key = `${id}:${page1}:${dpi}`;
  const hit = thumbs.get(key);
  if (hit) return hit;
  const p = getPreview(id);
  if (!p) throw new Error("preview expired or unknown");
  if (page1 < 1 || page1 > p.pages) throw new Error(`page ${page1} out of ${p.pages}`);
  const png = await renderPagePng(p.bytes, page1, dpi);
  thumbs.set(key, png);
  return png;
}
