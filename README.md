# ai-detect

Check documents for AI-generated content. Upload text or PDFs, watch each chunk get checked live, and download the report as JSON.

- Splits documents into sentence-aware chunks of 550 words or less.
- Checks each chunk against the [plagiarismcheck.org](https://plagiarismcheck.org) AI detector, one fresh guest account per chunk.
- Runs chunk checks in parallel with one shared browser. Default 5, max 10.
- Streams progress over SSE and highlights flagged sentences in each chunk.
- Rolls chunks up into a word-weighted verdict across the whole document.
- Reads PDF text layers and falls back to tesseract OCR for scanned pages.
- Shows every PDF page as a thumbnail. Click a page to ignore it. Only selected pages get checked.
- Takes several files at once and checks each file as its own document.
- Serves the same queue to LLMs through CLI flags and an MCP endpoint.
- Ships as one Docker image with Chromium bundled in. The host needs only Docker.

## Quick start

```bash
docker build -t ai-detect .
docker run --rm -p 3000:3000 ai-detect
# open http://localhost:3000
# Ctrl+C stops it cleanly
```

Run it on your VPS or home server and share the URL. There are no logins. One shared queue keeps the upstream IP safe.

## Configuration

Copy `.env.example` to `.env` and edit it. Bun reads `.env` on startup. The Dockerfile values apply when a variable is absent.

- `PORT`. HTTP port. Default 3000.
- `CHUNK_CONCURRENCY`. Parallel chunk checks across all files. Default 5, max 10.
- `TOKEN_CONCURRENCY`. Parallel token contexts in the browser. Defaults to chunk concurrency.
- `SUBMIT_GAP_MS`. Minimum gap between chunk submits. Default 1500.
- `CAPSOLVER_KEY`. Paid fallback for token minting. Unset by default.
- `CHROME_EXECUTABLE`. Browser binary. The image default is `/usr/bin/chromium`.

## Dev

```bash
bun install
bun run src/server.ts
cd frontend && bun install && bun run dev
```

The API serves on port 3000. The Vite dev server proxies `/api` there.

Local dev needs Chrome or Chromium on PATH, or `bunx playwright install chromium`. Token minting tries `CHROME_EXECUTABLE`, then system Chrome, then the Playwright browser.

## API

- `POST /api/jobs` takes multipart `text`, `file`, or `previewId` plus `pages` like `"1,3,5-7"` and `excludePages`. It returns `{jobId, chunks, words}`.
- `GET /api/jobs/:id` returns status, chunks, texts, and the aggregate.
- `GET /api/jobs/:id/events` streams progress as SSE.
- `GET /api/jobs/:id/report.json` downloads the full report.
- `POST /api/pdf/preview` takes a PDF and returns `{previewId, pages, info}` with per-page word counts.
- `GET /api/pdf/preview/:id/thumb/:n` and `/page/:n` render page PNGs for the overview.
- `/mcp` serves Streamable HTTP MCP with `submit_document`, `job_status`, `job_report`, `pdf_pages`, and `check_text`.

## CLI

```bash
bun run src/cli.ts --file essay.txt --out result.json
bun run src/cli.ts --file doc.pdf --list-pages
bun run src/cli.ts --file doc.pdf --pages 1-3 --json
bun run src/cli.ts --file doc.pdf --pages all --exclude-pages 1,2 --json
```

`--json` prints only the result JSON to stdout and sends logs to stderr, so you can pipe it into an LLM. `--list-pages` prints per-page word counts so an agent can pick pages first.
