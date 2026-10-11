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
`-e PACE_MS=5000` to slow the queue if throttled.

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
- **Queue** (`src/docjobs.ts`): global FIFO, 1 chunk-check at a time, ~3s pacing,
  fresh guest per chunk (== clear cookies + Shift+Alt+R), one retry on paywall.
- **Tokens** (`src/browser.ts`): one persistent Chromium mints a fresh-context
  v3 token per chunk (~1–2s). Friends *can* supply their own `guest`-action
  token via Advanced → it seeds the first chunk; the rest are server-minted.
  Scores are identical either way (see REPORT.md: 19/19 paired agreement).
- **PDF** (`src/pdf.ts`): embedded text layer via pdfjs; pages with <100 chars
  fall back to tesseract OCR (`tesseract` + `pdftoppm` if installed, always in Docker).
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
python ai_detect.py --file sample.txt --out result.json
bun run src/cli.ts --file sample.txt --out result-ts.json
bun run src/cli.ts --file sample.txt --token-profile client
```

## Docs

- `REPORT.md` — server-token vs client-token A/B (20×20): identical scores.
- Original flow notes live in `ai_detect.py`'s docstring.
