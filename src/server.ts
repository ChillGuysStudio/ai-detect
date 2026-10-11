#!/usr/bin/env bun
/** Bun + Hono server: document jobs API + static frontend. */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import {
  attachManualToken,
  createJob,
  getJob,
  jobSummary,
  queuePosition,
  subscribe,
  unsubscribe,
  type DocJob,
} from "./docjobs.ts";
import { extractPdf } from "./pdf.ts";
import { createPreview, getPreview, pagePng } from "./previews.ts";
import { excludePages, formatPages, parsePages } from "./pages.ts";
import { mcpHandler } from "./mcp.ts";

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3000);

function clientIp(c: { req: { header(n: string): string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

app.post("/api/jobs", async (c) => {
  const form = await c.req.formData();
  const manualToken = (form.get("manualToken") as string) || undefined;
  let text = "";
  let name = "pasted text";
  let extractMethod: string | undefined;
  let pageNote: string | undefined;
  const textField = form.get("text");
  const file = form.get("file");
  const previewId = form.get("previewId") as string | null;
  const pagesSpec = (form.get("pages") as string) || "all";
  const excludeSpec = (form.get("excludePages") as string) || undefined;
  if (previewId) {
    const prev = getPreview(previewId);
    if (!prev) return c.json({ error: "preview expired or unknown — re-upload the PDF" }, 404);
    try {
      const idx = excludePages(parsePages(pagesSpec, prev.pages), excludeSpec, prev.pages);
      const ex = await extractPdf(prev.bytes, { pages: idx });
      text = ex.text;
      name = prev.name;
      extractMethod = ex.method;
      pageNote = `pages ${formatPages(idx)} of ${prev.pages}`;
      if (!text.trim()) return c.json({ error: "selected pages contain no extractable text" }, 422);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  } else if (file instanceof File && file.size > 0) {
    name = file.name || "upload";
    const buf = new Uint8Array(await file.arrayBuffer());
    if (/\.pdf$/i.test(name)) {
      const lang = (form.get("ocrLang") as string) || "eng";
      try {
        // need total first for the spec; extractPdf validates selection
        const { pdfPageInfo } = await import("./pdf.ts");
        const { pages: total } = await pdfPageInfo(buf);
        const idx = excludePages(parsePages(pagesSpec, total), excludeSpec, total);
        const ex = await extractPdf(buf, { lang, pages: idx });
        text = ex.text;
        extractMethod = ex.method;
        if (idx.length < total) pageNote = `pages ${formatPages(idx)} of ${total}`;
        if (!text.trim()) {
          return c.json({ error: "no text extracted from PDF (scanned and OCR unavailable?)" }, 422);
        }
      } catch (e) {
        return c.json({ error: (e as Error).message }, 422);
      }
    } else {
      text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    }
  } else if (typeof textField === "string" && textField.trim()) {
    text = textField;
    name = "pasted text";
  } else {
    return c.json({ error: "provide 'text', a file, or a previewId" }, 400);
  }
  try {
    const job = createJob(pageNote ? `${name} (${pageNote})` : name, text, clientIp(c), extractMethod);
    if (manualToken) attachManualToken(job, manualToken);
    return c.json({ jobId: job.id, chunks: job.chunks.length, words: job.totalWords, pages: pageNote });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
  }
});

// PDF overview: upload once, browse thumbnails, submit selected pages.
app.post("/api/pdf/preview", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "upload a PDF file" }, 400);
  if (!/\.pdf$/i.test(file.name || "")) return c.json({ error: "not a PDF" }, 400);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const p = await createPreview(file.name, buf);
    const words = p.info.reduce((a, i) => a + i.words, 0);
    return c.json({ previewId: p.id, name: p.name, pages: p.pages, words, info: p.info });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
  }
});

app.get("/api/pdf/preview/:id/thumb/:n", async (c) => {
  try {
    const w = Math.min(480, Math.max(80, Number(c.req.query("w") ?? 240)));
    const dpi = w <= 160 ? 35 : w <= 320 ? 50 : 75;
    const png = await pagePng(c.req.param("id"), Number(c.req.param("n")), dpi);
    return new Response(png as unknown as BodyInit, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 404);
  }
});

app.get("/api/pdf/preview/:id/page/:n", async (c) => {
  try {
    const dpi = Math.min(200, Math.max(70, Number(c.req.query("dpi") ?? 110)));
    const png = await pagePng(c.req.param("id"), Number(c.req.param("n")), dpi);
    return new Response(png as unknown as BodyInit, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 404);
  }
});

app.get("/api/jobs/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "unknown job" }, 404);
  const full = jobSummary(job);
  return c.json({ ...full, queuePosition: queuePosition(job.id) });
});

app.get("/api/jobs/:id/report.json", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "unknown job" }, 404);
  c.header("Content-Disposition", `attachment; filename="report-${job.id}.json"`);
  return c.json(job);
});

app.get("/api/jobs/:id/events", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "unknown job" }, 404);
  // Already-finished jobs: snapshot + clean end so EventSource doesn't retry.
  const finished = job.status === "done" || job.status === "error";
  let ctrl!: ReadableStreamDefaultController;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stopHb = () => {
    if (hb) clearInterval(hb);
    hb = null;
  };
  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      subscribe(job.id, controller);
      controller.enqueue(`event: sync\ndata: ${JSON.stringify(jobSummary(job))}\n\n`);
      if (finished) {
        controller.enqueue(`event: end\ndata: {}\n\n`);
        controller.close();
        unsubscribe(job.id, controller);
      } else {
        // Heartbeat: chunk checks can run 15-60s+ with no events; without
        // traffic Bun idles the socket out (ERR_INCOMPLETE_CHUNKED_ENCODING).
        hb = setInterval(() => {
          try {
            controller.enqueue(`: ping\n\n`);
          } catch {
            stopHb();
          }
        }, 8000);
        // Safety: never hold a dead stream forever (client closes on end anyway).
        setTimeout(stopHb, 15 * 60 * 1000).unref?.();
      }
    },
    cancel() {
      stopHb();
      unsubscribe(job.id, ctrl);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// MCP (Streamable HTTP, stateless): any MCP client can submit/poll/read jobs.
app.all("/mcp", (c) => mcpHandler(c.req.raw));

// Frontend (built Vite app) if present, else a hint.
app.use("/*", serveStatic({ root: "./frontend-dist" }));
app.get("*", (c) =>
  c.text(
    "ai-detect API is running. Build the frontend (see frontend/README) or use:\n" +
      "  POST /api/jobs (multipart: text|file|previewId, pages, excludePages)\n  POST /api/pdf/preview (multipart: file) -> {previewId, pages, info}\n  GET /api/pdf/preview/:id/thumb/:n?w=240 | /page/:n?dpi=110 (PNG)\n  GET /api/jobs/:id\n  GET /api/jobs/:id/events (SSE)\n  GET /api/jobs/:id/report.json\n  /mcp (Streamable HTTP, tools: check_text, submit_document, job_status, job_report)\n",
  ),
);

console.log(`ai-detect listening on :${PORT}`);
console.log(
  `config: CHUNK_CONCURRENCY=${process.env.CHUNK_CONCURRENCY ?? 5} ` +
    `TOKEN_CONCURRENCY=${process.env.TOKEN_CONCURRENCY ?? process.env.CHUNK_CONCURRENCY ?? 5} ` +
    `SUBMIT_GAP_MS=${process.env.SUBMIT_GAP_MS ?? 1500} ` +
    `CAPSOLVER_KEY=${process.env.CAPSOLVER_KEY ? "set" : "unset"}`,
);
export default { port: PORT, fetch: app.fetch };
