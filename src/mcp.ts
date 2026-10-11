/** MCP tools (Streamable HTTP, stateless) sharing the server's queue + browser.
 *  Mounted at /mcp by server.ts. Any MCP client with network access can use it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createJob, getJob, jobSummary } from "./docjobs.ts";
import { excludePages, formatPages, parsePages } from "./pages.ts";
import { extractPdf, pdfPageInfo } from "./pdf.ts";
import { checkOnce } from "./jobs.ts";

function makeServer(): McpServer {
  const server = new McpServer({ name: "ai-detect", version: "1.0.0" });

  server.registerTool(
    "submit_document",
    {
      description:
        "Check a document for AI-generated content. Splits text into ≤550-word chunks, queues one check per chunk (fresh guest each). Returns a jobId - poll job_status, then read job_report. Prefer this over check_text for anything over ~500 words.",
      inputSchema: {
        text: z.string().optional().describe("Raw document text (>=100 words total)"),
        pdfBase64: z.string().optional().describe("PDF file, base64-encoded (alternative to text)"),
        pages: z.string().optional().describe('PDF pages to include, e.g. "1,3,5-7" (default all)'),
        excludePages: z.string().optional().describe('PDF pages to skip, e.g. "2,4"'),
        name: z.string().optional().describe("Document label for the report"),
      },
    },
    async ({ text, pdfBase64, pages, excludePages: excl, name }) => {
      try {
        let body = text?.trim() ?? "";
        let extractMethod: string | undefined;
        let pageNote: string | undefined;
        if (pdfBase64) {
          const buf = Uint8Array.from(Buffer.from(pdfBase64, "base64"));
          const { pages: total } = await pdfPageInfo(buf);
          const idx = excludePages(parsePages(pages, total), excl, total);
          const ex = await extractPdf(buf, { pages: idx });
          if (!ex.text.trim()) throw new Error("selected pages contain no extractable text");
          body = ex.text;
          extractMethod = ex.method;
          if (idx.length < total) pageNote = `pages ${formatPages(idx)} of ${total}`;
        }
        if (!body) throw new Error("provide text or pdfBase64");
        const job = createJob(pageNote ? `${name ?? "mcp document"} (${pageNote})` : (name ?? "mcp document"), body, "mcp", extractMethod);
        const s = jobSummary(job);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ jobId: job.id, chunks: s.total, words: job.totalWords, pages: pageNote ?? undefined }) }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "job_status",
    {
      description: "Poll a document job: queued/active/done + per-chunk progress. Call until status is done.",
      inputSchema: { jobId: z.string().describe("Job id from submit_document") },
    },
    async ({ jobId }) => {
      const job = getJob(jobId);
      if (!job) return { content: [{ type: "text" as const, text: "error: unknown job" }], isError: true };
      const s = jobSummary(job);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: s.status, done: s.done, total: s.total, aggregate: s.aggregate ?? null }) }],
      };
    },
  );

  server.registerTool(
    "job_report",
    {
      description: "Full job report: word-weighted aggregate verdict + per-chunk scores and flagged sentence ranges.",
      inputSchema: { jobId: z.string().describe("Job id from submit_document") },
    },
    async ({ jobId }) => {
      const job = getJob(jobId);
      if (!job) return { content: [{ type: "text" as const, text: "error: unknown job" }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify(job).slice(0, 90000) }] };
    },
  );

  server.registerTool(
    "pdf_pages",
    {
      description: "Inventory a PDF (base64): page count + per-page word counts, for picking pages before submit_document.",
      inputSchema: { pdfBase64: z.string().describe("PDF file, base64-encoded") },
    },
    async ({ pdfBase64 }) => {
      try {
        const buf = Uint8Array.from(Buffer.from(pdfBase64, "base64"));
        const { pages, info } = await pdfPageInfo(buf);
        return { content: [{ type: "text" as const, text: JSON.stringify({ pages, info }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "check_text",
    {
      description: "Single synchronous AI check for a short text (100-550 words). May take ~30-60s. For longer documents use submit_document + job_status + job_report.",
      inputSchema: { text: z.string().describe("Text to check (100-550 words)") },
    },
    async ({ text }) => {
      try {
        const words = text.split(/\s+/).filter(Boolean).length;
        if (words < 100) throw new Error(`only ${words} words (need >=100)`);
        if (words > 600) throw new Error(`${words} words too long for one check - use submit_document`);
        const r = await checkOnce(text, { tokenProfile: "server", verbose: false });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ strongPct: r.strong_percent, likelyPct: r.likely_percent, processedPct: r.processed_percent, conclusion: r.conclusion, chunks: r.chunks }),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}

const transportOpts = { enableJsonResponse: true };

/** Hono handler: stateless = new transport per request (SDK requirement);
 *  the McpServer is cheap to build and all tools share the job queue. */
export async function mcpHandler(req: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport(transportOpts);
  await makeServer().connect(transport);
  return transport.handleRequest(req);
}
