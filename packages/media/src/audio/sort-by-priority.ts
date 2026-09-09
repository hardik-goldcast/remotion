import {DEFAULT_AUDIO_FEED_SCHEDULER_CONFIG} from '../audio-scheduler/audio-feed-scheduler-config';

type Waiter = {
	getPriority: () => number | null;
	fn: () => Promise<unknown>;
	onDone: (result: unknown, triggerNext: () => void) => void;
	onError: (err: unknown) => void;
	concurrency: number;
	getMaxAheadSeconds: () => number;
};

type MaxAheadSeconds = number | (() => number);

export class StaleWaiterError extends Error {
	constructor() {
		super('Waiter became stale before it got its turn');
		this.name = 'StaleWaiterError';
	}
}

// Keep the original single-turn scheduler limit while we test buffering and
// lookahead independently from concurrency changes.
const DEFAULT_CONCURRENCY = 1;
export const GROUPED_AUDIO_SCHEDULER_CONCURRENCY = 1;
const DEFAULT_MAX_AHEAD_SECONDS = 2;
export const GROUPED_AUDIO_SCHEDULER_MAX_AHEAD_SECONDS =
	DEFAULT_AUDIO_FEED_SCHEDULER_CONFIG.decodeAheadSeconds;

const waiters: Waiter[] = [];
let running = 0;
type RunningEntry = {
	waiter: Waiter;
	concurrency: number;
	cancel: () => void;
	settle: () => void;
};
const runningEntries = new Set<RunningEntry>();

const countByConcurrency = (concurrencies: readonly number[]) => {
	const counts: Record<string, number> = {};
	for (const concurrency of concurrencies) {
		const key = String(concurrency);
		counts[key] = (counts[key] ?? 0) + 1;
	}

	return counts;
};

const getConcurrencyLimit = () => {
	let limit = DEFAULT_CONCURRENCY;
	for (const waiter of waiters) {
		limit = Math.max(limit, waiter.concurrency);
	}
	for (const entry of runningEntries) {
		limit = Math.max(limit, entry.concurrency);
	}
	return limit;
};

export const getAudioSchedulerQueueDiagnostics = () => ({
	pending: waiters.length,
	running,
	concurrencyLimit: getConcurrencyLimit(),
	pendingByConcurrency: countByConcurrency(
		waiters.map((waiter) => waiter.concurrency),
	),
	runningByConcurrency: countByConcurrency(
		Array.from(runningEntries, (entry) => entry.concurrency),
	),
});

const cancelStaleRunningEntries = () => {
	for (const entry of runningEntries) {
		if (entry.waiter.getPriority() === null) {
			// A stale decoder may still be resolving asynchronously, but freeing its
			// logical turn prevents it from blocking a fresh iterator after a seek or
			// anchor change. Its promise callback is ignored after cancellation.
			entry.cancel();
		}
	}
};

export const processNext = (): void => {
	cancelStaleRunningEntries();

	if (running >= getConcurrencyLimit()) {
		return;
	}

	// Collect stale waiters first, remove them from the queue,
	// and only then fire their onError callbacks. onError may synchronously
	// re-enter processNext, which would otherwise shrink `waiters` from under
	// the iteration and leave `waiters[i]` undefined on the next `i--`.
	const staleWaiters: Waiter[] = [];
	for (let i = waiters.length - 1; i >= 0; i--) {
		if (waiters[i].getPriority() === null) {
			const [stale] = waiters.splice(i, 1);
			staleWaiters.push(stale);
		}
	}

	for (const stale of staleWaiters) {
		stale.onError(new StaleWaiterError());
	}

	if (waiters.length === 0) {
		return;
	}

	let bestIndex = 0;
	let bestPriority = waiters[0].getPriority();
	let bestMaxAheadSeconds = waiters[0].getMaxAheadSeconds();
	if (bestPriority === null) {
		throw new Error('Stale waiter should have been removed');
	}

	for (let i = 1; i < waiters.length; i++) {
		const priority = waiters[i].getPriority();
		if (priority === null) {
			throw new Error('Stale waiter should have been removed');
		}

		if (priority < bestPriority) {
			bestPriority = priority;
			bestIndex = i;
			bestMaxAheadSeconds = waiters[i].getMaxAheadSeconds();
		}
	}

	if (bestPriority > bestMaxAheadSeconds) {
		// Do not decode farther ahead than the mode requested by this waiter.
		return;
	}

	const [next] = waiters.splice(bestIndex, 1);
	running++;

	let settled = false;
	let cancelled = false;
	const entry: RunningEntry = {
		waiter: next,
		concurrency: next.concurrency,
		cancel: () => {
			cancelled = true;
			entry.settle();
		},
		settle: () => {
			if (settled) {
				return;
			}

			settled = true;
			running--;
			runningEntries.delete(entry);
		},
	};
	runningEntries.add(entry);

	next.fn().then(
		(value) => {
			entry.settle();
			if (cancelled) {
				return;
			}

			next.onDone(value, processNext);
		},
		(err) => {
			entry.settle();
			if (cancelled) {
				return;
			}

			next.onError(err);
		},
	);
};

export const waitForTurn = <T>({
	getPriority,
	fn,
	onDone,
	onError,
	concurrency,
	maxAheadSeconds,
}: {
	getPriority: () => number | null;
	fn: () => Promise<T>;
	onDone: (result: T, triggerNext: () => void) => void;
	onError: (err: unknown) => void;
	concurrency?: number;
	maxAheadSeconds?: MaxAheadSeconds;
}): void => {
	const getMaxAheadSeconds = () => {
		const value =
			typeof maxAheadSeconds === 'function'
				? maxAheadSeconds()
				: (maxAheadSeconds ?? DEFAULT_MAX_AHEAD_SECONDS);
		return Math.max(0, value);
	};

	waiters.push({
		getPriority,
		fn,
		onDone: onDone as (result: unknown, triggerNext: () => void) => void,
		onError: onError as (err: unknown) => void,
		concurrency: Math.max(
			DEFAULT_CONCURRENCY,
			concurrency ?? DEFAULT_CONCURRENCY,
		),
		getMaxAheadSeconds,
	});
	processNext();
};
