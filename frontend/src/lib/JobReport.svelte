<script lang="ts">
	import { fly } from 'svelte/transition';
	import ChunkCard from './ChunkCard.svelte';
	import type { JobView } from './api.js';
	import { easeOut, ms } from './motion.js';

	let { job }: { job: JobView } = $props();

	const done = $derived(job.chunks.filter((c) => c.status === 'done').length);
	const total = $derived(job.chunks.length);
	const pct = $derived(total ? Math.round((done / total) * 100) : 0);
</script>

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
		<div in:fly={{ y: 8, duration: ms(200), easing: easeOut, delay: ms(Math.min(i * 40, 200)) }}>
			<ChunkCard {chunk} text={job.texts?.[i]} />
		</div>
	{/each}
</section>

<style>
	.panel {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 20px 22px;
		margin-bottom: 24px;
		box-shadow: var(--shadow-sm);
	}
	.topbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.actions a {
		color: var(--accent);
		font-weight: 600;
	}
	.meta {
		color: var(--ink-faint);
		font-size: 0.9em;
	}
	.error {
		color: var(--danger);
		font-weight: 600;
	}
	.progress {
		height: 8px;
		background: rgba(16, 24, 64, 0.08);
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
