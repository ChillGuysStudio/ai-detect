/** Motion helpers shared by transitions: strong ease-out + reduced-motion
 *  awareness (durations collapse to 0 so Svelte transitions become instant). */
import { cubicOut } from 'svelte/easing';

export const easeOut = cubicOut;

const reduceMotion =
	typeof window !== 'undefined' &&
	typeof window.matchMedia === 'function' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Duration in ms, or 0 under prefers-reduced-motion. */
export const ms = (n: number) => (reduceMotion ? 0 : n);
