<script lang="ts">
	import { fade, fly, scale } from 'svelte/transition';
	import {
		createJob,
		fetchJob,
		subscribeJob,
		uploadPreview,
		type JobView,
		type PdfPreview
	} from './lib/api.js';
	import JobReport from './lib/JobReport.svelte';
	import PdfOverview from './lib/PdfOverview.svelte';
	import { easeOut, ms } from './lib/motion.js';

	interface Upload {
		uid: string;
		kind: 'pdf' | 'text';
		file: File;
		name: string;
		sizeKb: number;
		loading: boolean;
		loadError: string;
		preview?: PdfPreview;
		ignored: number[];
		words: number;
		excerpt: string;
	}

	// ---- pasted text (submitted together with files by the single Check button) ----
	let text = $state('');
	let startError = $state('');

	// ---- multi-file batch flow ----
	let uploads = $state<Upload[]>([]);
	let overviewUid = $state<string | null>(null);
	let textviewUid = $state<string | null>(null);
	let batchJobs = $state<Record<string, JobView>>({});
	let batchStops = $state<Record<string, () => void>>({});
	let batchSubmitting = $state(false);

	const batchList = $derived(Object.values(batchJobs));
	const batchDone = $derived(batchList.reduce((a, j) => a + j.chunks.filter((c) => c.status === 'done').length, 0));
	const batchTotal = $derived(batchList.reduce((a, j) => a + j.chunks.length, 0));
	const batchPct = $derived(batchTotal ? Math.round((batchDone / batchTotal) * 100) : 0);
	const batchFinished = $derived(
		batchList.length > 0 && batchList.every((j) => j.status === 'done' || j.status === 'error')
	);

	let uidCounter = 0;
	const uid = () => `u${Date.now().toString(36)}${uidCounter++}`;

	async function addFiles(list: FileList | undefined) {
		if (!list) return;
		startError = '';
		for (const file of list) {
			const isPdf = /\.pdf$/i.test(file.name);
			const entry: Upload = {
				uid: uid(),
				kind: isPdf ? 'pdf' : 'text',
				file,
				name: file.name,
				sizeKb: Math.round(file.size / 1024),
				loading: isPdf,
				loadError: '',
				ignored: [],
				words: 0,
				excerpt: ''
			};
			uploads.push(entry);
			// NOTE: mutate through the $state proxy (looked up by uid), not the
			// raw `entry` object - raw writes bypass reactivity and never render.
			const at = () => uploads.find((x) => x.uid === entry.uid);
			if (isPdf) {
				uploadPreview(file)
					.then((p) => {
						const u = at();
						if (!u) return;
						u.preview = p;
						u.words = p.words;
						u.loading = false;
					})
					.catch((e) => {
						const u = at();
						if (!u) return;
						u.loadError = (e as Error).message;
						u.loading = false;
					});
			} else {
				try {
					const t = await file.text();
					const u = at();
					if (!u) return;
					u.words = t.match(/\S+/g)?.length ?? 0;
					u.excerpt = t.slice(0, 3000);
				} catch (e) {
					const u = at();
					if (u) u.loadError = (e as Error).message;
				}
			}
		}
	}

	function removeUpload(id: string) {
		uploads = uploads.filter((u) => u.uid !== id);
		if (overviewUid === id) overviewUid = null;
		if (textviewUid === id) textviewUid = null;
		startError = '';
	}

	function includedPages(u: Upload): number[] {
		if (!u.preview) return [];
		return u.preview.info.map((i) => i.page).filter((p) => !u.ignored.includes(p));
	}

	function specOf(nums: number[]): string {
		const s = [...nums].sort((a, b) => a - b);
		const ranges: string[] = [];
		let start = s[0];
		let prev = s[0];
		for (const n of s.slice(1)) {
			if (n === prev + 1) prev = n;
			else {
				ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
				start = prev = n;
			}
		}
		if (s.length) ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
		return ranges.join(',');
	}

	const filesReady = $derived(
		uploads.every(
			(u) =>
				!u.loading &&
				!u.loadError &&
				(u.kind === 'pdf' ? (u.preview ? includedPages(u).length > 0 : false) : u.words > 0)
		)
	);
	const hasText = $derived(text.trim().length > 0);
	const parts = $derived.by(() => {
		const p: string[] = [];
		if (hasText) p.push('pasted text');
		if (uploads.length > 0) p.push(`${uploads.length} file${uploads.length === 1 ? '' : 's'}`);
		return p;
	});
	const checkLabel = $derived(
		batchSubmitting ? 'Submitting…' : parts.length ? `Check ${parts.join(' + ')}` : 'Check'
	);
	const canCheck = $derived(
		!batchSubmitting && (hasText || (uploads.length > 0 && filesReady))
	);

	/** Single Check button: pasted text (if any) + every listed file, one job each. */
	async function checkAll() {
		startError = '';
		if (!hasText && uploads.length === 0) {
			startError = 'Paste text or choose a file.';
			return;
		}
		if (hasText && text.trim().split(/\s+/).length < 100) {
			startError = 'Pasted text is under 100 words - add more or remove it.';
			return;
		}
		if (uploads.length > 0 && !filesReady) {
			startError = 'Some files are not ready yet (still reading, failed, or nothing selected).';
			return;
		}
		batchSubmitting = true;
		try {
			if (hasText) await submitOne(() => createJob({ text: text.trim() }));
			for (const u of uploads) {
				const res =
					u.kind === 'pdf' && u.preview
						? await createJob({ previewId: u.preview.previewId, pages: specOf(includedPages(u)) })
						: await createJob({ file: u.file });
				await trackJob(res.jobId);
			}
		} catch (e) {
			startError = (e as Error).message;
		} finally {
			batchSubmitting = false;
		}
	}

	async function submitOne(create: () => Promise<{ jobId: string }>) {
		const { jobId: id } = await create();
		await trackJob(id);
	}

	async function trackJob(id: string) {
		batchJobs[id] = await fetchJob(id);
		batchStops[id] = subscribeJob(id, (name, data) => applyBatchEvent(id, name, data));
	}

	function applyBatchEvent(id: string, name: string, data: unknown) {
		const d = data as Record<string, unknown>;
		const j = batchJobs[id];
		if (name === 'sync') {
			batchJobs[id] = d as unknown as JobView;
			return;
		}
		if (name === 'end') {
			batchStops[id]?.();
			delete batchStops[id];
			return;
		}
		if (!j) return;
		if (name === 'message' && d && typeof d === 'object' && 'type' in d) {
			const t = d.type as string;
			if (t === 'chunk-started' && typeof d.index === 'number') {
				const c = j.chunks[d.index];
				if (c) c.status = 'active';
				batchJobs[id] = j;
			} else if ((t === 'chunk-done' || t === 'chunk-error') && typeof d.index === 'number') {
				j.chunks[d.index] = d.chunk as JobView['chunks'][number];
				batchJobs[id] = j;
			} else if (t === 'job-done') {
				j.aggregate = d.aggregate as JobView['aggregate'];
				j.status = 'done';
				batchJobs[id] = j;
				batchStops[id]?.();
				delete batchStops[id];
			} else if (t === 'job-error') {
				j.status = 'error';
				j.error = d.error as string;
				batchJobs[id] = j;
				batchStops[id]?.();
				delete batchStops[id];
			} else if (t === 'job-started') {
				j.status = 'active';
				batchJobs[id] = j;
			}
		}
	}

	function resetAll() {
		for (const stop of Object.values(batchStops)) stop();
		batchStops = {};
		batchJobs = {};
		uploads = [];
		overviewUid = null;
		textviewUid = null;
		text = '';
		startError = '';
	}

	const overviewEntry = $derived(uploads.find((u) => u.uid === overviewUid) ?? null);
	const textviewEntry = $derived(uploads.find((u) => u.uid === textviewUid) ?? null);
</script>

<main>
	<header class="hero">
		<h1>ai-detect</h1>
		<p>Know what you're submitting. Sentence-level AI detection for whole documents.</p>
	</header>

	{#if Object.keys(batchJobs).length > 0}
		<section class="panel summary" in:fly={{ y: 12, duration: ms(240), easing: easeOut }}>
			<div class="topbar">
				<div>
					<strong>{batchList.length} document{batchList.length === 1 ? '' : 's'}</strong>
					<span class="meta">{batchDone}/{batchTotal} chunks · {batchPct}%</span>
				</div>
				<button class="ghost" onclick={resetAll}>New check</button>
			</div>
			<div class="progress" role="progressbar" aria-valuenow={batchPct} aria-valuemin="0" aria-valuemax="100">
				<div class="bar" style="width: {batchPct}%"></div>
			</div>
			{#if batchFinished}<p class="meta">All files processed.</p>{/if}
		</section>
		{#each batchList as j, k (j.id)}
			<div in:fly={{ y: 12, duration: ms(240), easing: easeOut, delay: ms(Math.min(k * 60, 240)) }}>
				<JobReport job={j} />
			</div>
		{/each}
	{:else}
		<section class="panel">
			<label>
				Paste text (100+ words)
				<textarea
				bind:value={text}
				rows="6"
				placeholder="Paste the document text here…"
				oninput={() => (startError = '')}
			></textarea>
			</label>
			<div class="row">
				<label class="file">
					…or choose files (.txt, .md, .pdf - several at once)
					<input
						type="file"
						accept=".txt,.md,.pdf,.text"
						multiple
						onchange={(e) => addFiles(e.currentTarget.files ?? undefined)}
					/>
				</label>
			</div>

			{#if uploads.length > 0}
				<ul class="uploads">
					{#each uploads as u, i (u.uid)}
						<li in:fly={{ y: 8, duration: ms(200), easing: easeOut, delay: ms(Math.min(i * 40, 200)) }}>
							<button
								class="rowbtn"
								onclick={() => (u.kind === 'pdf' && u.preview ? (overviewUid = u.uid) : u.kind === 'text' ? (textviewUid = u.uid) : null)}
								aria-label="Open {u.name}"
							>
								<span class="fname">{u.name}</span>
								{#if u.loading}
									<span class="meta">reading pages…</span>
								{:else if u.loadError}
									<span class="error">{u.loadError}</span>
								{:else if u.kind === 'pdf' && u.preview}
									<span class="meta">
										{u.preview.pages} pages · {u.preview.words} words ·
										{u.preview.info.length - u.ignored.length}/{u.preview.pages} selected
									</span>
								{:else}
									<span class="meta">{u.words} words</span>
								{/if}
							</button>
							<button class="ghost x" onclick={() => removeUpload(u.uid)} aria-label="Remove {u.name}">✕</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if startError}
				<p class="error">{startError}</p>
			{/if}
			<div class="actions">
				<button class="primary" onclick={checkAll} disabled={!canCheck}>{checkLabel}</button>
			</div>
			<p class="hint">Pasted text and files are each checked as their own document; text is split into ≤550-word chunks.</p>
		</section>
	{/if}

	{#if overviewEntry?.preview}
		<PdfOverview
			preview={overviewEntry.preview}
			ignored={overviewEntry.ignored}
			onChange={(sel) => {
				overviewEntry.ignored = sel;
				startError = '';
			}}
			onClose={() => (overviewUid = null)}
		/>
	{/if}

	{#if textviewEntry && textviewEntry.kind === 'text'}
		<div
			class="overlay"
			role="button"
			tabindex="0"
			aria-label="Close text preview"
			transition:fade={{ duration: ms(160) }}
			onclick={(e) => {
				if (e.target === e.currentTarget) textviewUid = null;
			}}
			onkeydown={(e) => {
				if (e.key === 'Escape') textviewUid = null;
			}}
		>
			<div
				class="modal"
				role="dialog"
				tabindex="-1"
				aria-label={textviewEntry.name}
				in:scale={{ start: 0.96, duration: ms(200), easing: easeOut }}
			>
				<div class="zoomhead">
					<span><strong>{textviewEntry.name}</strong> · {textviewEntry.words} words</span>
					<button class="ghost" onclick={() => (textviewUid = null)} aria-label="Close">✕</button>
				</div>
				<pre>{textviewEntry.excerpt}{textviewEntry.words > 0 && textviewEntry.excerpt.length >= 3000 ? '…' : ''}</pre>
			</div>
		</div>
	{/if}
</main>

<style>
	:global(body) {
		font-family: system-ui, -apple-system, sans-serif;
		background: var(--page);
		color: var(--ink);
		margin: 0;
	}
	main {
		max-width: 720px;
		margin: 0 auto;
		padding: 48px 20px 96px;
	}
	.hero {
		text-align: center;
		margin-bottom: 28px;
	}
	.hero h1 {
		margin: 0;
		font-size: 2rem;
		letter-spacing: -0.03em;
	}
	.hero p {
		margin: 8px 0 0;
		color: var(--ink-faint);
		font-size: 1.02rem;
	}
	.panel {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 24px;
		box-shadow: var(--shadow-sm);
	}
	.panel.summary {
		margin-bottom: 24px;
	}
	label {
		display: block;
		font-weight: 600;
		margin-bottom: 8px;
	}
	label > textarea {
		margin-top: 14px;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--surface-soft);
		transition:
			border-color 150ms ease,
			box-shadow 150ms var(--ease-out);
	}
	textarea:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
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
	.hint {
		color: var(--ink-faint);
		font-size: 0.9em;
		text-align: center;
	}
	.error {
		color: var(--danger);
		font-weight: 600;
	}
	button {
		font: inherit;
		font-weight: 600;
		background: var(--accent);
		color: var(--accent-ink);
		border: 0;
		border-radius: var(--radius-sm);
		padding: 10px 18px;
		cursor: pointer;
	}
	button.primary {
		width: 100%;
		padding: 13px 18px;
		font-size: 1.02rem;
	}
	button[disabled] {
		opacity: 0.6;
		cursor: default;
	}
	button.ghost {
		background: var(--ghost-bg);
		color: var(--ink);
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
		margin-top: 12px;
		flex-wrap: wrap;
	}
	.meta {
		color: var(--ink-faint);
		font-size: 0.9em;
	}
	.progress {
		height: 8px;
		background: var(--track);
		border-radius: 999px;
		overflow: hidden;
		margin-top: 12px;
	}
	.bar {
		height: 100%;
		background: var(--accent);
		border-radius: 999px;
		transition: width 0.5s linear;
	}
	.uploads {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
	}
	.uploads li {
		display: flex;
		gap: 8px;
		align-items: center;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		margin-bottom: 12px;
		padding: 6px 6px 6px 12px;
		background: var(--surface);
		box-shadow: var(--shadow-sm);
	}
	.rowbtn {
		flex: 1;
		min-width: 0;
		display: flex;
		gap: 10px;
		align-items: baseline;
		background: none;
		border: 0;
		padding: 6px;
		cursor: pointer;
		font: inherit;
		text-align: left;
		color: var(--ink);
	}
	.fname {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.x {
		flex: none;
		padding: 6px 12px;
	}
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(10, 15, 35, 0.65);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
		padding: 16px;
	}
	.modal {
		background: var(--surface);
		border-radius: var(--radius);
		max-width: 760px;
		width: 100%;
		max-height: 92vh;
		overflow: auto;
		padding: 20px 24px;
		box-shadow: var(--shadow-md);
	}
	.zoomhead {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
		font-weight: 600;
	}
	pre {
		white-space: pre-wrap;
		font: inherit;
		line-height: 1.55;
		color: var(--body-text);
	}
</style>
