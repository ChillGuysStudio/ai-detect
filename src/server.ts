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
  const textField = form.get("text");
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    name = file.name || "upload";
    const buf = new Uint8Array(await file.arrayBuffer());
    if (/\.pdf$/i.test(name)) {
      const lang = (form.get("ocrLang") as string) || "eng";
      const ex = await extractPdf(buf, lang);
      text = ex.text;
      extractMethod = ex.method;
      if (!text.trim()) {
        return c.json({ error: "no text extracted from PDF (scanned and OCR unavailable?)" }, 422);
      }
    } else {
      text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    }
  } else if (typeof textField === "string" && textField.trim()) {
    text = textField;
    name = "pasted text";
  } else {
    return c.json({ error: "provide 'text' or upload a file" }, 400);
  }
  try {
    const job = createJob(name, text, clientIp(c), extractMethod);
    if (manualToken) attachManualToken(job, manualToken);
    return c.json({ jobId: job.id, chunks: job.chunks.length, words: job.totalWords });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
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
  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      subscribe(job.id, controller);
      controller.enqueue(`event: sync\ndata: ${JSON.stringify(jobSummary(job))}\n\n`);
      if (finished) {
        controller.enqueue(`event: end\ndata: {}\n\n`);
        controller.close();
        unsubscribe(job.id, controller);
      }
    },
    cancel() {
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

// Frontend (built Vite app) if present, else a hint.
app.use("/*", serveStatic({ root: "./frontend-dist" }));
app.get("*", (c) =>
  c.text(
    "ai-detect API is running. Build the frontend (see frontend/README) or use:\n" +
      "  POST /api/jobs (multipart: text|file)\n  GET /api/jobs/:id\n  GET /api/jobs/:id/events (SSE)\n  GET /api/jobs/:id/report.json\n",
  ),
);

console.log(`ai-detect listening on :${PORT}`);
export default { port: PORT, fetch: app.fetch };
