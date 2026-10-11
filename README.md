# ai-detect — document AI checker (self-hostable)

Upload text or PDF → split into ≤550-word chunks → each chunk checked against
plagiarismcheck.org's TraceGPT AI detector → live progress + per-chunk results
→ word-weighted aggregate report (on screen + JSON for AI processing).

## Quick start (Docker — recommended)

```bash
docker build -t ai-detect .
docker run -p 3000:3000 ai-detect
# open http://localhost:3000
```

Share with friends: run it on your VPS/home server and give them the URL.
No logins — one global queue (concurrency 1) keeps the upstream IP safe.
Optional: `docker run -e CAPSOLVER_KEY=...` as token fallback,
`-e CHUNK_CONCURRENCY=10 -e TOKEN_CONCURRENCY=10` for max parallelism
(watch for upstream throttling), `-e SUBMIT_GAP_MS=1500` to tune politeness.

## Dev

```bash
bun install
bun run src/server.ts        # API + frontend on :3000 (serve ./frontend-dist)
cd frontend && bun install && bun run dev   # Vite dev (proxies /api to :3000)
```

## How it works

- **Chunking** (`src/chunk.ts`): sentence-aware greedy pack, target ~450 words,
  hard cap **550**. Each chunk gets its own guest account, so quota isn't the
  constraint — accuracy sweet spot (200–550w) + progress granularity is.
- **Queue** (`src/docjobs.ts`): global FIFO (one active job), chunks run in a
  worker pool — `CHUNK_CONCURRENCY` (default 5, max 10), one browser with
  parallel contexts (not one Chromium per chunk), fresh guest per chunk,
  shared 1.5s submit throttle (`SUBMIT_GAP_MS`), one retry on paywall.
  A 4-chunk doc completes in ~20s wall vs ~65s sequential.
- **Tokens** (`src/browser.ts`): one persistent Chromium mints a fresh-context
  v3 token per chunk (~1–2s), fully server-side and free — this is the method
  in use (client-minted tokens score identically per REPORT.md, but nothing
  needs to provide them). `POST /api/jobs` still accepts an optional
  `manualToken` to seed the first chunk if upstream ever throttles us.
- **PDF** (`src/pdf.ts`): embedded text layer via pdfjs; pages with <100 chars
  fall back to tesseract OCR (`tesseract` + `pdftoppm` if installed, always in Docker).
  Uploads open a **page overview**: thumbnails for every page (all included —
  click a page to ignore it, click again to include; 🔍 zooms to a minimal
  content + ✕ view). Only selected pages are extracted and queued.
  API: `POST /api/pdf/preview` → `GET .../thumb/:n` / `page/:n`,
  `POST /api/jobs` takes `previewId` + `pages` (`"1,3,5-7"`) + `excludePages`.
- **Live updates**: `GET /api/jobs/:id/events` (SSE) streams
  `chunk-started/done/error`, `job-done`; the Svelte 5 UI appends cards as they
  arrive and shows the aggregate when complete.
- **Report**: word-weighted `avgStrong`/`avgLikely`, verdict
  (≥60% detected / ≥30% mixed / else likely-human), flagged chunks (≥50%),
  sentence-level highlights from the detector's own position data.
  `GET /api/jobs/:id/report.json` downloads the full job JSON.

## API

- `POST /api/jobs` (multipart `text`|`file`, optional `manualToken`, `ocrLang`)
  → `{jobId, chunks, words}`
- `GET /api/jobs/:id` → status + chunks + texts + aggregate
- `GET /api/jobs/:id/events` → SSE stream
- `GET /api/jobs/:id/report.json` → download

## CLI (single texts, no server)

```bash
bun run src/cli.ts --file sample.txt --out result-ts.json
bun run src/cli.ts --file sample.txt --token-profile client
# PDFs: inventory pages, then check only some (LLM-friendly pure JSON)
bun run src/cli.ts --file doc.pdf --list-pages
bun run src/cli.ts --file doc.pdf --pages 1-3 --json
bun run src/cli.ts --file doc.pdf --pages all --exclude-pages 1,2 --json
```

`--json` prints only the result JSON to stdout (logs go to stderr, exit codes
preserved) — pipe it straight into an LLM. `--list-pages` prints per-page
word counts so an agent can pick pages first.

## MCP (any model with network access)

Same container serves Streamable HTTP MCP at `/mcp` (stateless, shares the
job queue + browser — no duplicate load). Tools: `submit_document`
(text or base64 PDF + `pages`/`excludePages`), `job_status`, `job_report`,
`pdf_pages`, `check_text` (short texts, sync). Point any MCP client at
`http://host:3000/mcp`.
