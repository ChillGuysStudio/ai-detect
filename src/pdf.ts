/** PDF text extraction: pdfjs text layer first, tesseract OCR fallback for scans.
 *  Page-filtered extraction + PNG rendering back the file-overview UI. */
import { $ } from "bun";

export interface PdfExtract {
  text: string;
  /** 1-based numbers of the pages actually included */
  includedPages: number[];
  pages: number;
  /** "text" = embedded layer, "ocr" = scanned, "mixed" = some pages OCR'd */
  method: "text" | "ocr" | "mixed";
  ocrPages: number[];
}

export interface PdfPageInfo {
  page: number; // 1-based
  words: number;
  chars: number;
}

async function hasBin(name: string): Promise<boolean> {
  if (typeof (Bun as unknown as { which?: (n: string) => string | null }).which === "function") {
    return (Bun as unknown as { which: (n: string) => string | null }).which(name) !== null;
  }
  try {
    await $`command -v ${name}`.quiet().text();
    return true;
  } catch {
    return false;
  }
}

function tmpPrefix(tag: string): string {
  return `${process.env.TMPDIR ?? "/tmp"}/${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function openDoc(data: Uint8Array): Promise<any> {
  // @ts-ignore - optional dependency, untyped legacy build
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
  // fresh plain-ArrayBuffer copy: pdfjs neuters/transfers input, and Bun's
  // Buffer subclass trips its structured-clone path on reuse
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return pdfjs.getDocument({ data: copy.buffer as ArrayBuffer }).promise;
}

async function pageText(doc: any, n1: number): Promise<string> {
  const page = await doc.getPage(n1);
  const tc = await page.getTextContent();
  return tc.items.map((it: unknown) => (it as { str?: string }).str ?? "").join(" ");
}

async function closeDoc(doc: any) {
  try {
    await doc.cleanup?.();
  } catch {
    /* best-effort */
  }
  try {
    await doc.destroy?.();
  } catch {
    /* best-effort */
  }
}

/** Word/char counts per page (text layer only - cheap, used by the overview UI). */
export async function pdfPageInfo(data: Uint8Array): Promise<{ pages: number; info: PdfPageInfo[] }> {
  const doc = await openDoc(data);
  try {
    const info: PdfPageInfo[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const t = await pageText(doc, n);
      info.push({ page: n, words: t.match(/\S+/g)?.length ?? 0, chars: t.trim().length });
    }
    return { pages: doc.numPages, info };
  } finally {
    await closeDoc(doc);
  }
}

/** Group 0-based indices into contiguous 1-based [first,last] ranges. */
function toRanges(idx: number[]): Array<[number, number]> {
  const s = [...idx].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let start = s[0];
  let prev = s[0];
  for (const n of s.slice(1)) {
    if (n === prev + 1) prev = n;
    else {
      out.push([start + 1, prev + 1]);
      start = prev = n;
    }
  }
  out.push([start + 1, prev + 1]);
  return out;
}

async function ocrRanges(
  data: Uint8Array,
  ranges: Array<[number, number]>,
  lang: string,
): Promise<Map<number, string>> {
  // 0-based index -> OCR text
  const out = new Map<number, string>();
  const tmp = tmpPrefix("ocr");
  await Bun.write(`${tmp}.pdf`, data);
  try {
    for (const [first, last] of ranges) {
      await $`pdftoppm -r 200 -png -f ${String(first)} -l ${String(last)} ${`${tmp}.pdf`} ${`${tmp}-${first}-${last}`}`.quiet();
      const { readdir } = await import("node:fs/promises");
      const files = (await readdir("/tmp"))
        .filter((f) => f.startsWith(`${tmp.split("/").pop()}-${first}-${last}`) && f.endsWith(".png"))
        .sort();
      let n = first;
      for (const f of files) {
        const txt = await $`tesseract /tmp/${f} stdout -l ${lang}`.quiet().nothrow().text();
        if (txt.trim()) out.set(n - 1, txt.trim());
        n++;
      }
    }
    return out;
  } finally {
    await $`rm -f ${tmp}.pdf ${tmp}-*.png`.quiet().nothrow();
  }
}

const MIN_CHARS_PER_PAGE = 100;

export interface ExtractOpts {
  lang?: string;
  /** 0-based page indices to include (default: all). */
  pages?: number[];
}

export async function extractPdf(data: Uint8Array, opts: ExtractOpts = {}): Promise<PdfExtract> {
  const { lang = "eng" } = opts;
  const doc = await openDoc(data);
  let selected: number[];
  try {
    const total: number = doc.numPages;
    selected = (opts.pages ?? Array.from({ length: total }, (_, i) => i)).filter((i) => i >= 0 && i < total);
    if (selected.length === 0) throw new Error("no pages selected");
    const layered = new Map<number, string>();
    for (const i of selected) layered.set(i, await pageText(doc, i + 1));
    const weak = selected.filter((i) => (layered.get(i) ?? "").trim().length < MIN_CHARS_PER_PAGE);
    let method: PdfExtract["method"] = "text";
    const ocrPages: number[] = [];
    if (weak.length > 0 && (await hasBin("tesseract")) && (await hasBin("pdftoppm"))) {
      try {
        const ocr = await ocrRanges(data, toRanges(weak), lang);
        for (const i of weak) {
          const t = ocr.get(i);
          if (t) {
            layered.set(i, t);
            ocrPages.push(i + 1);
          }
        }
        method = ocrPages.length === selected.length ? "ocr" : ocrPages.length > 0 ? "mixed" : "text";
      } catch {
        /* fall through with text layer */
      }
    }
    const ordered = [...selected].sort((a, b) => a - b);
    return {
      text: ordered.map((i) => layered.get(i) ?? "").join("\n\n"),
      includedPages: ordered.map((i) => i + 1),
      pages: total,
      method,
      ocrPages: ocrPages.sort((a, b) => a - b),
    };
  } finally {
    await closeDoc(doc);
  }
}

/** Render one page to PNG (thumbnails + zoom view). dpi 50 ≈ thumb, 110 ≈ zoom. */
export async function renderPagePng(data: Uint8Array, page1: number, dpi = 50): Promise<Uint8Array> {
  if (!(await hasBin("pdftoppm"))) throw new Error("pdftoppm not available (install poppler-utils)");
  const tmp = tmpPrefix("thumb");
  await Bun.write(`${tmp}.pdf`, data);
  try {
    await $`pdftoppm -r ${String(dpi)} -png -f ${String(page1)} -l ${String(page1)} -singlefile ${`${tmp}.pdf`} ${tmp}`.quiet();
    return new Uint8Array(await Bun.file(`${tmp}.png`).arrayBuffer());
  } finally {
    await $`rm -f ${tmp}.pdf ${tmp}.png`.quiet().nothrow();
  }
}
