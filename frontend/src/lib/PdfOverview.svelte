<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { pageImageUrl, thumbUrl, type PdfPreview } from './api.js';

	let {
		preview,
		onSubmit,
		onBack
	}: {
		preview: PdfPreview;
		onSubmit: (pagesSpec: string) => void;
		onBack: () => void;
	} = $props();

	// All pages included by default; this set holds the ignored ones.
	let ignored = new SvelteSet<number>();
	let zoom = $state<number | null>(null);

	const included = $derived(preview.info.map((i) => i.page).filter((p) => !ignored.has(p)));
	const includedWords = $derived(
		preview.info.filter((i) => !ignored.has(i.page)).reduce((a, i) => a + i.words, 0)
	);

	function toggle(p: number) {
		if (ignored.has(p)) ignored.delete(p);
		else ignored.add(p);
	}

	function toggleAll() {
		if (ignored.size === 0) {
			for (const i of preview.info) ignored.add(i.page);
		} else {
			ignored.clear();
		}
	}

	function spec(): string {
		const s = [...included].sort((a, b) => a - b);
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

</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') zoom = null;
	}}
/>

<section class="panel">
	<div class="topbar">
		<div>
			<strong>{preview.name}</strong>
			<span class="meta">{preview.pages} pages · {preview.words} words</span>
		</div>
		<button class="ghost" onclick={onBack}>← Change file</button>
	</div>
	<p class="hint">Click a page to ignore it (click again to include). Click 🔍 to zoom in.</p>

	<div class="grid">
		{#each preview.info as i (i.page)}
			{@const off = ignored.has(i.page)}
			<div
				class="thumb"
				class:off
				role="checkbox"
				aria-checked={!off}
				aria-label="Page {i.page}, {i.words} words, {off ? 'ignored' : 'included'}"
				tabindex="0"
				onclick={() => toggle(i.page)}
				onkeydown={(e) => {
					if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
						e.preventDefault();
						toggle(i.page);
					}
				}}
			>
				<img src={thumbUrl(preview.previewId, i.page)} alt="Page {i.page}" loading="lazy" />
				<button
					class="zoom"
					aria-label="Zoom page {i.page}"
					onclick={(e) => {
						e.stopPropagation();
						zoom = i.page;
					}}
				>
					🔍
				</button>
				<span class="cap" class:off>P{i.page} · {i.words}w {#if off}<em>ignored</em>{/if}</span>
			</div>
		{/each}
	</div>

	<div class="footer">
		<button class="ghost" onclick={toggleAll}>{ignored.size === 0 ? 'Ignore all' : 'Include all'}</button>
		<button onclick={() => onSubmit(spec())} disabled={included.length === 0}>
			Check {included.length}/{preview.pages} pages ({includedWords} words)
		</button>
	</div>
</section>

{#if zoom != null}
	<div
		class="overlay"
		role="button"
		tabindex="0"
		aria-label="Close zoom"
		onclick={(e) => {
			if (e.target === e.currentTarget) zoom = null;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') zoom = null;
			if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) zoom = null;
		}}
	>
		<div class="modal" role="dialog" tabindex="-1" aria-label="Page {zoom}">
			<div class="zoomhead">
				<span>Page {zoom}/{preview.pages}</span>
				<button class="ghost x" onclick={() => (zoom = null)} aria-label="Close preview">✕</button>
			</div>
			<img src={pageImageUrl(preview.previewId, zoom, 110)} alt="Page {zoom} enlarged" />
		</div>
	</div>
{/if}

<style>
	.panel {
		background: #fff;
		border: 1px solid #e2e4ec;
		border-radius: 12px;
		padding: 20px;
	}
	.topbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.meta {
		color: #666d84;
		font-size: 0.9em;
	}
	.hint {
		color: #666d84;
		font-size: 0.9em;
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
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
		gap: 12px;
		margin: 12px 0;
	}
	.thumb {
		position: relative;
		border: 1px solid #e2e4ec;
		border-radius: 8px;
		overflow: hidden;
		background: #fafbfe;
		cursor: pointer;
	}
	.thumb:focus-visible {
		outline: 2px solid #2952cc;
		outline-offset: 2px;
	}
	.thumb.off {
		opacity: 0.55;
	}
	.thumb > img {
		width: 100%;
		display: block;
	}
	.zoom {
		position: absolute;
		right: 6px;
		top: 6px;
		background: rgba(16, 24, 64, 0.75);
		border-radius: 6px;
		padding: 4px 8px;
		font-size: 0.95em;
	}
	.cap {
		display: block;
		padding: 6px 8px;
		font-size: 0.85em;
	}
	.cap.off {
		text-decoration: line-through;
	}
	.thumb em {
		color: #b3261e;
		font-style: normal;
		font-weight: 600;
	}
	.footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-top: 8px;
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
		background: #fff;
		border-radius: 12px;
		max-width: 760px;
		width: 100%;
		max-height: 92vh;
		overflow: auto;
		padding: 16px 20px;
	}
	.zoomhead {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
		font-weight: 600;
	}
	.zoomhead .x {
		flex: none;
	}
	.modal img {
		width: 100%;
		display: block;
		border: 1px solid #e2e4ec;
		border-radius: 8px;
	}
</style>
