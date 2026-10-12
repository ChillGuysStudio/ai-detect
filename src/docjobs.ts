/** Document jobs: jobs start immediately (FIFO); CHUNKS share one global slot
 *  pool, so chunks of different files run in parallel up to the cap.
 *  SSE events, aggregate report. */
import { chunkText } from "./chunk.ts";
import {
  createGuest,
  getCsrf,
  newJar,
  pollResult,
  submitAiCheck,
  validateText,
  type CheckResult,
  PaywallError,
} from "./core.ts";
import { mintTokenWithFallback } from "./browser.ts";
import { checkUpstream, isRetryableNetworkError, upstreamMessage } from "./net.ts";

export type ChunkStatus = "queued" | "active" | "done" | "error";
export type JobStatus = "queued" | "active" | "done" | "error";

export interface ChunkState {
  index: number;
  text: string;
  words: number;
  status: ChunkStatus;
  checkId?: number;
  strongPct?: string;
  likelyPct?: string;
  processedPct?: string;
  conclusion?: string;
  chunks?: CheckResult["chunks"];
  error?: string;
  attempts: number;
}

export interface Aggregate {
  totalWords: number;
  doneChunks: number;
  totalChunks: number;
  avgStrong: number;
  avgLikely: number;
  verdict: string;
  flagged: Array<{ index: number; words: number; strong: number; conclusion?: string }>;
}

export interface DocJob {
  id: string;
  name: string;
  fromIp: string;
  createdAt: number;
  status: JobStatus;
  totalWords: number;
  extractMethod?: string;
  chunks: ChunkState[];
  aggregate?: Aggregate;
  error?: string;
}

export type JobEvent =
  | { type: "job-started"; jobId: string }
  | { type: "chunk-started"; jobId: string; index: number }
  | { type: "chunk-done"; jobId: string; index: number; chunk: ChunkState }
  | { type: "chunk-error"; jobId: string; index: number; chunk: ChunkState }
  | { type: "job-done"; jobId: string; aggregate: Aggregate }
  | { type: "job-error"; jobId: string; error: string };

const jobs = new Map<string, DocJob>();
const subs = new Map<string, Set<ReadableStreamDefaultController>>();
const queue: string[] = [];

/** Global chunk slots shared across ALL jobs: chunks of different files run
 *  in parallel up to this cap (one browser, N contexts - not N browsers).
 *  CHUNK_CONCURRENCY default 5, hard cap 10 (upstream throttle safety). */
const CHUNK_CONCURRENCY = Math.min(10, Math.max(1, Number(process.env.CHUNK_CONCURRENCY ?? 5)));
let activeChunks = 0;
const chunkWaiters: Array<() => void> = [];

async function chunkSlot(): Promise<() => void> {
  while (activeChunks >= CHUNK_CONCURRENCY) {
    await new Promise<void>((resolve) => chunkWaiters.push(resolve));
  }
  activeChunks++;
  return () => {
    activeChunks--;
    chunkWaiters.shift()?.();
  };
}
/** Min gap between chunk submits across workers (shared politeness throttle). */
const SUBMIT_GAP_MS = Number(process.env.SUBMIT_GAP_MS ?? 1500);
let lastSubmit = 0;

async function submitGate(): Promise<void> {
  for (;;) {
    const wait = lastSubmit + SUBMIT_GAP_MS - Date.now();
    if (wait <= 0) break;
    await Bun.sleep(Math.min(wait, 250));
  }
  lastSubmit = Date.now();
}

export function getJob(id: string): DocJob | undefined {
  return jobs.get(id);
}

export function emit(jobId: string, ev: JobEvent) {
  const set = subs.get(jobId);
  if (!set || set.size === 0) return;
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  // NOTE: never close() live controllers here - the client closes the
  // EventSource on job-done/end. Server-side close races the last write
  // and surfaces as ERR_INCOMPLETE_CHUNKED_ENCODING in Chromium.
  for (const c of [...set]) {
    try {
      c.enqueue(data);
      if (ev.type === "job-done" || ev.type === "job-error") {
        c.enqueue(`event: end\ndata: {}\n\n`);
      }
    } catch {
      set.delete(c);
    }
  }
}

export function subscribe(jobId: string, ctrl: ReadableStreamDefaultController) {
  if (!subs.has(jobId)) subs.set(jobId, new Set());
  subs.get(jobId)!.add(ctrl);
}

export function unsubscribe(jobId: string, ctrl: ReadableStreamDefaultController) {
  subs.get(jobId)?.delete(ctrl);
}

/** Snapshot without full chunk texts (list view); full detail via getJob. */
export function jobSummary(j: DocJob) {
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    totalWords: j.totalWords,
    extractMethod: j.extractMethod,
    createdAt: j.createdAt,
    done: j.chunks.filter((c) => c.status === "done").length,
    total: j.chunks.length,
    aggregate: j.aggregate,
    error: j.error,
    texts: j.chunks.map((c) => c.text),
    chunks: j.chunks.map((c) => ({
      index: c.index,
      words: c.words,
      status: c.status,
      checkId: c.checkId,
      strongPct: c.strongPct,
      likelyPct: c.likelyPct,
      processedPct: c.processedPct,
      conclusion: c.conclusion,
      chunks: c.chunks,
      error: c.error,
      attempts: c.attempts,
    })),
  };
}

export function createJob(name: string, text: string, fromIp: string, extractMethod?: string): DocJob {
  const words = text.match(/\S+/g)?.length ?? 0;
  if (words < 100) throw new Error(`only ${words} words (site requires >=100)`);
  const parts = chunkText(text);
  const job: DocJob = {
    id: crypto.randomUUID(),
    name,
    fromIp,
    createdAt: Date.now(),
    status: "queued",
    totalWords: words,
    extractMethod,
    chunks: parts.map((p) => ({
      index: p.index,
      text: p.text,
      words: p.words,
      status: "queued" as ChunkStatus,
      attempts: 0,
    })),
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  void pump();
  return job;
}

async function pump() {
  // No active-job gate: every queued job starts at once; the shared chunk
  // slots (+ submit throttle) bound actual upstream load instead.
  for (;;) {
    const nextId = queue.shift();
    if (!nextId) return;
    const job = jobs.get(nextId);
    if (!job) continue;
    job.status = "active";
    emit(job.id, { type: "job-started", jobId: job.id });
    void runJob(job).then(
      () => {},
      (e) => {
        job.status = "error";
        job.error = (e as Error).message;
        emit(job.id, { type: "job-error", jobId: job.id, error: job.error });
      },
    );
  }
}

async function runChunk(
  job: DocJob,
  chunk: ChunkState,
  opts: { manualToken?: string; capsolverKey?: string },
): Promise<void> {
  // Global slot: chunks across jobs share the pool, so a 3-chunk file and a
  // 1-chunk file overlap instead of serializing per job.
  const release = await chunkSlot();
  try {
    await runChunkInner(job, chunk, opts);
  } finally {
    release();
  }
}

async function runChunkInner(
  job: DocJob,
  chunk: ChunkState,
  opts: { manualToken?: string; capsolverKey?: string },
): Promise<void> {
  chunk.status = "active";
  emit(job.id, { type: "chunk-started", jobId: job.id, index: chunk.index });
  // Up to 3 attempts, each with a brand-new guest. Paywall errors and
  // transient network failures retry with backoff; validation and token
  // errors fail immediately since repeating the input cannot fix them.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    chunk.attempts++;
    const jar = newJar();
    try {
      const csrf = await getCsrf(jar);
      const token =
        opts.manualToken && chunk.index === 0 && attempt === 0
          ? opts.manualToken // friend-provided token seeds the first chunk
          : await mintTokenWithFallback("server", opts.capsolverKey);
      const api = await createGuest(jar, csrf.guest_csrf, token);
      await validateText(jar, api, chunk.text);
      await submitGate();
      const sub = await submitAiCheck(jar, api, chunk.text);
      chunk.checkId = sub.id;
      const res = await pollResult(jar, api, sub.id, 3000, 600000, false);
      chunk.status = "done";
      // human-written texts come back with null percents + "Most likely written by a human"
      chunk.strongPct = res.strong_percent ?? "0.00";
      chunk.likelyPct = res.likely_percent ?? "0.00";
      chunk.processedPct = res.processed_percent ?? "0.00";
      chunk.conclusion = res.conclusion ?? undefined;
      chunk.chunks = res.chunks;
      emit(job.id, { type: "chunk-done", jobId: job.id, index: chunk.index, chunk: stripText(chunk) });
      return;
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof PaywallError || isRetryableNetworkError(e);
      if (!retryable || attempt === 2) break;
      await Bun.sleep(attempt === 0 ? 2000 : 6000);
    }
  }
  chunk.status = "error";
  chunk.error = upstreamMessage(lastErr);
  emit(job.id, { type: "chunk-error", jobId: job.id, index: chunk.index, chunk: stripText(chunk) });
}

function stripText(c: ChunkState): ChunkState {
  return { ...c, text: "" };
}

function aggregate(job: DocJob): Aggregate {
  const done = job.chunks.filter((c) => c.status === "done");
  const words = done.reduce((a, c) => a + c.words, 0) || 1;
  const avg = (pick: (c: ChunkState) => string | undefined) =>
    done.reduce((a, c) => a + parseFloat(pick(c) ?? "0") * c.words, 0) / words;
  const avgStrong = avg((c) => c.strongPct);
  const avgLikely = avg((c) => c.likelyPct);
  const flagged = done
    .filter((c) => parseFloat(c.strongPct ?? "0") >= 50)
    .map((c) => ({ index: c.index, words: c.words, strong: parseFloat(c.strongPct ?? "0"), conclusion: c.conclusion }))
    .sort((a, b) => b.strong - a.strong);
  const verdict =
    done.length === 0
      ? "No chunks completed"
      : avgStrong >= 60
        ? "AI content detected"
        : avgStrong >= 30
          ? "Mixed signals - review flagged chunks"
          : "Likely human-written";
  return {
    totalWords: job.totalWords,
    doneChunks: done.length,
    totalChunks: job.chunks.length,
    avgStrong: Math.round(avgStrong * 100) / 100,
    avgLikely: Math.round(avgLikely * 100) / 100,
    verdict,
    flagged,
  };
}

async function runJob(job: DocJob) {
  const capsolverKey = process.env.CAPSOLVER_KEY;
  const manualToken = (job as DocJob & { manualToken?: string }).manualToken;
  // Fail fast when the site is unreachable instead of burning every chunk.
  await checkUpstream();
  let cursor = 0;
  const worker = async (wid: number) => {
    await Bun.sleep(wid * 400); // stagger worker starts
    for (;;) {
      const i = cursor++;
      if (i >= job.chunks.length) return;
      const chunk = job.chunks[i];
      try {
        await runChunk(job, chunk, { manualToken, capsolverKey });
      } catch (e) {
        chunk.status = "error";
        chunk.error = upstreamMessage(e);
        emit(job.id, { type: "chunk-error", jobId: job.id, index: chunk.index, chunk: stripText(chunk) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, job.chunks.length) }, (_, w) => worker(w)));
  job.aggregate = aggregate(job);
  job.status = job.chunks.some((c) => c.status === "done") ? "done" : "error";
  if (job.status === "error") job.error = "all chunks failed";
  emit(job.id, { type: "job-done", jobId: job.id, aggregate: job.aggregate });
}

export function attachManualToken(job: DocJob, token: string) {
  (job as DocJob & { manualToken?: string }).manualToken = token;
}

/** Queue position for display (0 = active/next). */
export function queuePosition(id: string): number {
  return queue.indexOf(id);
}
