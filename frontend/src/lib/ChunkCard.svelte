<script lang="ts">
	import type { ChunkView } from './api.js';

	let { chunk, text }: { chunk: ChunkView; text?: string } = $props();

	let open = $state(false);

	/** Render chunk text with flagged (reliability>=2) spans highlighted. */
	function segments(): Array<{ t: string; flagged: boolean }> {
		if (!text || !chunk.chunks?.length) return text ? [{ t: text, flagged: false }] : [];
		const spans = [...chunk.chunks]
			.filter((c) => c.reliability >= 2)
			.sort((a, b) => a.position[0] - b.position[0]);
		const out: Array<{ t: string; flagged: boolean }> = [];
		let pos = 0;
		for (const s of spans) {
			const [a, b] = s.position;
			if (a > pos) out.push({ t: text.slice(pos, a), flagged: false });
			out.push({ t: text.slice(a, b), flagged: true });
			pos = Math.max(pos, b);
		}
		if (pos < text.length) out.push({ t: text.slice(pos), flagged: false });
		return out;
	}

	const dot = $derived(
		chunk.status === 'done'
			? parseFloat(chunk.strongPct ?? '0') >= 50
				? 'bad'
				: 'ok'
			: chunk.status
	);
</script>

<div class="card {dot}" class:open>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="dot"></span>
		<strong>Chunk {chunk.index + 1}</strong>
		<span class="meta">{chunk.words} words</span>
		{#if chunk.status === 'done'}
			<span class="meta">AI {chunk.strongPct}% · likely {chunk.likelyPct}%</span>
			<span class="chev">▸</span>
		{:else if chunk.status === 'active'}
			<span class="meta">checking…</span>
		{:else if chunk.status === 'error'}
			<span class="meta err">{chunk.error ?? 'failed'}</span>
		{:else}
			<span class="meta">queued</span>
		{/if}
	</button>
	{#if open && text}
		<div class="body">
			{#if chunk.status === 'done' && chunk.conclusion}
				<p class="conclusion">{chunk.conclusion}</p>
			{/if}
			<p class="text">
				{#each segments() as s}
					{#if s.flagged}<mark>{s.t}</mark>{:else}{s.t}{/if}
				{/each}
			</p>
		</div>
	{/if}
</div>

<style>
	.card {
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		margin: 8px 0;
		background: var(--surface);
		box-shadow: var(--shadow-sm);
	}
	.head {
		display: flex;
		gap: 8px;
		align-items: center;
		width: 100%;
		padding: 10px 12px;
		background: none;
		border: 0;
		cursor: pointer;
		font: inherit;
		text-align: left;
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #c3c7d4;
		flex: none;
	}
	.bad .dot {
		background: var(--danger);
	}
	.ok .dot {
		background: var(--ok);
	}
	.active .dot {
		background: var(--warn);
		animation: pulse-dot 1.2s var(--ease-in-out) infinite;
	}
	@keyframes pulse-dot {
		50% {
			opacity: 0.35;
		}
	}
	.meta {
		color: var(--ink-faint);
		font-size: 0.9em;
	}
	.meta.err {
		color: var(--danger);
	}
	.chev {
		margin-left: auto;
		color: var(--ink-faint);
		transition: transform 180ms var(--ease-out);
	}
	.open .chev {
		transform: rotate(90deg);
	}
	.body {
		padding: 0 12px 12px;
	}
	.conclusion {
		font-weight: 600;
		margin: 4px 0 8px;
	}
	.text {
		line-height: 1.55;
		color: #232838;
		white-space: pre-wrap;
	}
	mark {
		background: rgba(214, 69, 69, 0.16);
		border-radius: 2px;
	}
</style>
