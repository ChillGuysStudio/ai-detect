/** PDF text extraction: pdfjs text layer first, tesseract OCR fallback for scans. */
import { $ } from "bun";

export interface PdfExtract {
  text: string;
  pages: number;
  /** "text" = embedded layer, "ocr" = scanned, "mixed" = some pages OCR'd */
  method: "text" | "ocr" | "mixed";
  ocrPages: number[];
}

async function hasBin(name: string): Promise<boolean> {
  try {
    await $`command -v ${name}`.quiet().text();
    return true;
  } catch {
    return false;
  }
}

async function pdfjsPages(data: Uint8Array): Promise<string[]> {
  // @ts-ignore - optional dependency, untyped legacy build
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
  const doc: any = await pdfjs.getDocument({ data }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out.push(tc.items.map((it: unknown) => (it as { str?: string }).str ?? "").join(" "));
    try {
      await doc.cleanup?.();
    } catch {
      /* best-effort */
    }
  }
  try {
    await doc.destroy?.();
  } catch {
    /* best-effort */
  }
  return out;
}

async function ocrPdf(data: Uint8Array, lang = "eng"): Promise<string[]> {
  // pdftoppm (poppler) renders pages -> tesseract OCRs them. Both optional.
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/ocr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await Bun.write(`${tmp}.pdf`, data);
  try {
    await $`pdftoppm -r 200 -png ${`${tmp}.pdf`} ${tmp}`.quiet();
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir("/tmp")).filter((f) => f.startsWith(tmp.split("/").pop()!) && f.endsWith(".png")).sort();
    const out: string[] = [];
    for (const f of files) {
      const txt = await $`tesseract /tmp/${f} stdout -l ${lang}`.quiet().text();
      out.push(txt.trim());
    }
    return out;
  } finally {
    await $`rm -f ${tmp}.pdf ${tmp}-*.png`.quiet().nothrow();
  }
}

const MIN_CHARS_PER_PAGE = 100;

export async function extractPdf(data: Uint8Array, lang = "eng"): Promise<PdfExtract> {
  const layered = await pdfjsPages(data);
  const weak = layered.map((t, i) => (t.trim().length < MIN_CHARS_PER_PAGE ? i : -1)).filter((i) => i >= 0);
  if (weak.length === 0) {
    return { text: layered.join("\n\n"), pages: layered.length, method: "text", ocrPages: [] };
  }
  if ((await hasBin("tesseract")) && (await hasBin("pdftoppm"))) {
    try {
      const ocr = await ocrPdf(data, lang);
      const merged = layered.map((t, i) => (weak.includes(i) && ocr[i]?.trim() ? ocr[i] : t));
      return {
        text: merged.join("\n\n"),
        pages: layered.length,
        method: weak.length === layered.length ? "ocr" : "mixed",
        ocrPages: weak.filter((i) => ocr[i]?.trim()),
      };
    } catch {
      /* fall through with text layer */
    }
  }
  return { text: layered.join("\n\n"), pages: layered.length, method: "text", ocrPages: [] };
}
