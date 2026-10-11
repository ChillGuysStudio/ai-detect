<script lang="ts">
	import { createJob, fetchJob, subscribeJob, type JobView } from './lib/api.js';
	import ChunkCard from './lib/ChunkCard.svelte';

	let text = $state('');
	let files = $state<FileList | undefined>(undefined);
	let manualToken = $state('');
	let starting = $state(false);
	let startError = $state('');
	let jobId = $state<string | null>(null);
	let job = $state<JobView | null>(null);
	let stopSSE = $state<(() => void) | null>(null);

	const done = $derived(job ? job.chunks.filter((c) => c.status === 'done').length : 0);
	const total = $derived(job?.chunks.length ?? 0);
	const pct = $derived(total ? Math.round((done / total) * 100) : 0);

	async function start() {
		startError = '';
		const file = files?.[0];
		if (!text.trim() && !file) {
			startError = 'Paste text or choose a file.';
			return;
		}
		starting = true;
		try {
			const res = await createJob({
				text: text.trim() || undefined,
				file,
				manualToken: manualToken.trim() || undefined
			});
			jobId = res.jobId;
			job = null;
		} catch (e) {
			startError = (e as Error).message;
		} finally {
			starting = false;
		}
	}

	function reset() {
		jobId = null;
		job = null;
		text = '';
		files = undefined;
	}

	function applyEvent(name: string, data: unknown) {
		const d = data as Record<string, unknown>;
		if (name === 'sync') {
			job = d as unknown as JobView;
			return;
		}
		if (name === 'end') {
			stopSSE?.();
			stopSSE = null;
			return;
		}
		if (!job) return;
		if (name === 'message' && d && typeof d === 'object' && 'type' in d) {
			const t = d.type as string;
			if (t === 'chunk-started' && typeof d.index === 'number') {
				const c = job.chunks[d.index];
				if (c) c.status = 'active';
			} else if ((t === 'chunk-done' || t === 'chunk-error') && typeof d.index === 'number') {
				job.chunks[d.index] = d.chunk as JobView['chunks'][number];
			} else if (t === 'job-done') {
				job.aggregate = d.aggregate as JobView['aggregate'];
				job.status = 'done';
				stopSSE?.();
				stopSSE = null;
			} else if (t === 'job-error') {
				job.status = 'error';
				job.error = d.error as string;
				stopSSE?.();
				stopSSE = null;
			} else if (t === 'job-started') {
				job.status = 'active';
			}
		}
	}

	$effect(() => {
		if (!jobId) return;
		let stop: (() => void) | null = null;
		let cancelled = false;
		fetchJob(jobId)
			.then((j) => {
				if (!cancelled) job = j;
			})
			.catch((e) => {
				startError = (e as Error).message;
			});
		stop = subscribeJob(jobId, (name, data) => applyEvent(name, data));
		stopSSE = stop;
		return () => {
			cancelled = true;
			stop?.();
			stopSSE = null;
		};
	});
</script>

<main>
	<h1>ai-detect <span class="sub">document AI check</span></h1>

	{#if !jobId}
		<section class="panel">
			<label>
				Paste text (100+ words)
				<textarea bind:value={text} rows="10" placeholder="Paste the document text here…"></textarea>
			</label>
			<div class="row">
				<label class="file">
					…or choose a file (.txt, .md, .pdf)
					<input type="file" accept=".txt,.md,.pdf,.text" bind:files />
				</label>
			</div>
			{#if files?.[0]}
				<p class="hint">Selected: {files[0].name} ({Math.round(files[0].size / 1024)} KB)</p>
			{/if}
			<details>
				<summary>Advanced: bring your own reCAPTCHA token</summary>
				<p class="hint">
					Optional. The server mints tokens itself by default. If checks get throttled,
					paste a <code>guest</code>-action token minted on plagiarismcheck.org in your own
					browser — it seeds the first chunk.
				</p>
				<input bind:value={manualToken} placeholder="03AFcWeA…" />
			</details>
			{#if startError}
				<p class="error">{startError}</p>
			{/if}
			<button onclick={start} disabled={starting}>
				{starting ? 'Starting…' : 'Check document'}
			</button>
			<p class="hint">Text is split into ≤550-word chunks; each chunk is checked separately.</p>
		</section>
	{:else if !job}
		<p>Loading job…</p>
	{:else}
		<section class="panel">
			<div class="topbar">
				<div>
					<strong>{job.name}</strong>
					<span class="meta">{job.totalWords} words · {job.total} chunks</span>
					{#if job.extractMethod && job.extractMethod !== 'text'}
						<span class="meta">· PDF via {job.extractMethod === 'ocr' ? 'OCR' : 'text+OCR'}</span>
					{/if}
				</div>
				<div class="actions">
					<a href={`/api/jobs/${job.id}/report.json`} download>JSON ↓</a>
					<button class="ghost" onclick={reset}>New check</button>
				</div>
			</div>

			{#if job.status === 'queued'}
				<p>Queued… position {job.queuePosition ?? '?'}</p>
			{/if}

			<div class="progress" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100">
				<div class="bar" style="width: {pct}%"></div>
			</div>
			<p class="meta">{done}/{total} chunks · {pct}%</p>

			{#if job.aggregate && job.status === 'done'}
				<div class="agg">
					<h2>{job.aggregate.verdict}</h2>
					<p>
						Weighted AI <strong>{job.aggregate.avgStrong}%</strong> · likely
						<strong>{job.aggregate.avgLikely}%</strong> across {job.aggregate.doneChunks} chunks.
					</p>
					{#if job.aggregate.flagged.length}
						<p class="meta">
							Flagged chunks: {job.aggregate.flagged.map((f) => `#${f.index + 1} (${f.strong}%)`).join(', ')}
						</p>
					{:else}
						<p class="meta">No chunk crossed the 50% flag threshold.</p>
					{/if}
				</div>
			{/if}
			{#if job.status === 'error' && !job.aggregate}
				<p class="error">Job failed: {job.error ?? 'unknown'}</p>
			{/if}

			{#each job.chunks as chunk, i (chunk.index)}
				<ChunkCard {chunk} text={job.texts?.[i]} />
			{/each}
		</section>
	{/if}
</main>

<style>
	:global(body) {
		font-family: system-ui, -apple-system, sans-serif;
		background: #f4f6fb;
		color: #101840;
		margin: 0;
	}
	main {
		max-width: 860px;
		margin: 0 auto;
		padding: 24px 16px 64px;
	}
	h1 .sub {
		font-weight: 400;
		color: #666d84;
		font-size: 0.6em;
	}
	.panel {
		background: #fff;
		border: 1px solid #e2e4ec;
		border-radius: 12px;
		padding: 20px;
	}
	label {
		display: block;
		font-weight: 600;
		margin-bottom: 8px;
	}
	textarea,
	input:not([type]) {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 10px;
		border: 1px solid #c9cede;
		border-radius: 8px;
	}
	textarea {
		resize: vertical;
	}
	.row {
		margin-top: 12px;
	}
	.file input {
		margin-top: 6px;
	}
	details {
		margin: 12px 0;
	}
	summary {
		cursor: pointer;
		color: #2952cc;
	}
	.hint {
		color: #666d84;
		font-size: 0.9em;
	}
	.error {
		color: #b3261e;
		font-weight: 600;
	}
	button {
		font: inherit;
		font-weight: 600;
		background: #2952cc;
		color: #fff;
		border: 0;
		border-radius: 8px;
		padding: 10px 18px;
		cursor: pointer;
	}
	button[disabled] {
		opacity: 0.6;
		cursor: default;
	}
	button.ghost {
		background: #eef1f8;
		color: #101840;
	}
	.topbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.actions a {
		color: #2952cc;
		font-weight: 600;
	}
	.meta {
		color: #666d84;
		font-size: 0.9em;
	}
	.progress {
		height: 10px;
		background: #e7eaf3;
		border-radius: 6px;
		overflow: hidden;
		margin-top: 12px;
	}
	.bar {
		height: 100%;
		background: #2952cc;
		transition: width 0.4s ease;
	}
	.agg {
		background: #f2f5ff;
		border: 1px solid #c9d4ff;
		border-radius: 8px;
		padding: 12px 16px;
		margin: 12px 0;
	}
	.agg h2 {
		margin: 0 0 4px;
	}
	.agg p {
		margin: 4px 0;
	}
</style>
