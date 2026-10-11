<script lang="ts">
	import { fade, fly, scale } from 'svelte/transition';
	import { pageImageUrl, thumbUrl, type PdfPreview } from './api.js';
	import { easeOut, ms } from './motion.js';

	let {
		preview,
		ignored = [],
		onChange,
		onClose
	}: {
		preview: PdfPreview;
		ignored?: number[];
		onChange?: (ignored: number[]) => void;
		onClose: () => void;
	} = $props();

	// All pages included by default; `ignored` (owned by the parent so the
	// selection survives closing the modal) holds the ignored page numbers.
	let zoom = $state<number | null>(null);

	const isOff = (p: number) => ignored.includes(p);
	const included = $derived(preview.info.map((i) => i.page).filter((p) => !isOff(p)));
	const includedWords = $derived(
		preview.info.filter((i) => !isOff(i.page)).reduce((a, i) => a + i.words, 0)
	);

	function toggle(p: number) {
		onChange?.(isOff(p) ? ignored.filter((x) => x !== p) : [...ignored, p]);
	}

	function toggleAll() {
		onChange?.(ignored.length === 0 ? preview.info.map((i) => i.page) : []);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') zoom != null ? (zoom = null) : onClose();
	}}
/>

<div
	class="overlay below"
	role="button"
	tabindex="0"
	aria-label="Close page overview"
	transition:fade={{ duration: ms(160) }}
	onclick={(e) => {
		if (e.target === e.currentTarget) onClose();
	}}
	onkeydown={(e) => {
		if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) onClose();
	}}
>
	<div
		class="modal wide"
		role="dialog"
		tabindex="-1"
		aria-label="Pages of {preview.name}"
		in:scale={{ start: 0.96, duration: ms(200), easing: easeOut }}
	>
		<div class="zoomhead">
			<span><strong>{preview.name}</strong> · {preview.pages} pages · {preview.words} words</span>
			<button class="ghost x" onclick={onClose} aria-label="Close page overview">✕</button>
		</div>
		<p class="hint">Click a page to ignore it (click again to include). Click 🔍 to zoom in.</p>

		<div class="grid">
			{#each preview.info as i, idx (i.page)}
				{@const off = isOff(i.page)}
				<div
					class="thumb lift"
					class:off
					role="checkbox"
					aria-checked={!off}
					aria-label="Page {i.page}, {i.words} words, {off ? 'ignored' : 'included'}"
					tabindex="0"
					in:fly={{ y: 10, duration: ms(220), easing: easeOut, delay: ms(Math.min(idx * 35, 280)) }}
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
			<button class="ghost" onclick={toggleAll}>{ignored.length === 0 ? 'Ignore all' : 'Include all'}</button>
			<span class="meta">{included.length}/{preview.pages} pages · {includedWords} words selected</span>
			<button onclick={onClose}>Done</button>
		</div>
	</div>
</div>

{#if zoom != null}
	<div
		class="overlay"
		role="button"
		tabindex="0"
		aria-label="Close zoom"
		transition:fade={{ duration: ms(160) }}
		onclick={(e) => {
			if (e.target === e.currentTarget) zoom = null;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') zoom = null;
			if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) zoom = null;
		}}
	>
		<div
			class="modal"
			role="dialog"
			tabindex="-1"
			aria-label="Page {zoom}"
			in:scale={{ start: 0.96, duration: ms(200), easing: easeOut }}
		>
			<div class="zoomhead">
				<span>Page {zoom}/{preview.pages}</span>
				<button class="ghost x" onclick={() => (zoom = null)} aria-label="Close preview">✕</button>
			</div>
			<img src={pageImageUrl(preview.previewId, zoom, 110)} alt="Page {zoom} enlarged" />
		</div>
	</div>
{/if}

<style>
	.meta {
		color: var(--ink-faint);
		font-size: 0.9em;
	}
	.hint {
		color: var(--ink-faint);
		font-size: 0.9em;
		text-align: center;
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
	button.ghost {
		background: rgba(16, 24, 64, 0.07);
		color: var(--ink);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
		gap: 12px;
		margin: 12px 0;
	}
	.thumb {
		position: relative;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: var(--surface-soft);
		cursor: pointer;
		transition:
			opacity 160ms ease,
			box-shadow 180ms var(--ease-out),
			transform 180ms var(--ease-out);
	}
	.thumb:focus-visible {
		outline: 2px solid var(--accent);
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
		color: var(--danger);
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
	.overlay.below {
		z-index: 40;
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
	.modal.wide {
		max-width: 980px;
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
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
	}
</style>
