export interface ChunkView {
	index: number;
	words: number;
	status: 'queued' | 'active' | 'done' | 'error';
	checkId?: number;
	strongPct?: string;
	likelyPct?: string;
	processedPct?: string;
	conclusion?: string;
	chunks?: Array<{ position: [number, number]; reliability: number }>;
	error?: string;
}

export interface AggregateView {
	totalWords: number;
	doneChunks: number;
	totalChunks: number;
	avgStrong: number;
	avgLikely: number;
	verdict: string;
	flagged: Array<{ index: number; words: number; strong: number; conclusion?: string }>;
}

export interface JobView {
	id: string;
	name: string;
	status: 'queued' | 'active' | 'done' | 'error';
	totalWords: number;
	extractMethod?: string;
	done: number;
	total: number;
	aggregate?: AggregateView;
	error?: string;
	chunks: ChunkView[];
	texts?: string[];
	queuePosition?: number;
}

export interface PdfPreview {
	previewId: string;
	name: string;
	pages: number;
	words: number;
	info: Array<{ page: number; words: number; chars: number }>;
}

export async function uploadPreview(file: File): Promise<PdfPreview> {
	const form = new FormData();
	form.append('file', file);
	const res = await fetch('/api/pdf/preview', { method: 'POST', body: form });
	if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
	return res.json();
}

export const thumbUrl = (previewId: string, page: number, w = 240) =>
	`/api/pdf/preview/${previewId}/thumb/${page}?w=${w}`;
export const pageImageUrl = (previewId: string, page: number, dpi = 110) =>
	`/api/pdf/preview/${previewId}/page/${page}?dpi=${dpi}`;

export async function createJob(input: {
	text?: string;
	file?: File;
	previewId?: string;
	pages?: string;
	manualToken?: string;
}): Promise<{ jobId: string; chunks: number; words: number }> {
	const form = new FormData();
	if (input.file) form.append('file', input.file);
	if (input.text) form.append('text', input.text);
	if (input.previewId) form.append('previewId', input.previewId);
	if (input.pages) form.append('pages', input.pages);
	if (input.manualToken) form.append('manualToken', input.manualToken);
	const res = await fetch('/api/jobs', { method: 'POST', body: form });
	if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
	return res.json();
}

export async function fetchJob(id: string): Promise<JobView> {
	const res = await fetch(`/api/jobs/${id}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** Subscribe to SSE; returns an unsubscribe fn. Handler receives (eventName, payload). */
export function subscribeJob(id: string, onEvent: (name: string, data: unknown) => void): () => void {
	const es = new EventSource(`/api/jobs/${id}/events`);
	const handler = (e: MessageEvent) => {
		try {
			onEvent((e as MessageEvent & { type?: string }).type || 'message', JSON.parse(e.data));
		} catch {
			/* keep-alive or malformed */
		}
	};
	for (const name of ['sync', 'message', 'end']) {
		es.addEventListener(name, handler as EventListener);
	}
	es.onerror = () => {
		/* server closes stream at job end; browser auto-retries otherwise */
	};
	return () => es.close();
}
