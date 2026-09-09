import type {useBufferState} from 'remotion';
import type {
	DelayPlaybackIfNotPremounting,
	DelayPlaybackMetadata,
} from './delay-playback-if-not-premounting';

type TrackedDelayHandle = {
	arm: () => void;
	disarm: (reason?: string) => void;
	dispose: () => void;
};

export class PremountAwareDelayPlayback {
	private isPremounting: boolean;
	private isPostmounting: boolean;
	private lifecycleVersion = 0;
	private readonly activeHandles = new Set<TrackedDelayHandle>();
	private readonly delayPlayback: ReturnType<
		typeof useBufferState
	>['delayPlayback'];
	private readonly baseMetadata: DelayPlaybackMetadata;

	constructor({
		bufferState,
		isPremounting,
		isPostmounting,
		baseMetadata = {},
	}: {
		bufferState: ReturnType<typeof useBufferState>;
		isPremounting: boolean;
		isPostmounting: boolean;
		baseMetadata?: DelayPlaybackMetadata;
	}) {
		this.delayPlayback = bufferState.delayPlayback;
		this.isPremounting = isPremounting;
		this.isPostmounting = isPostmounting;
		this.baseMetadata = baseMetadata;
	}

	private shouldDelayPlayback(): boolean {
		return !this.isPremounting && !this.isPostmounting;
	}

	private syncHandles(reason: string): void {
		for (const handle of this.activeHandles) {
			if (this.shouldDelayPlayback()) {
				handle.arm();
			} else {
				handle.disarm(reason);
			}
		}
	}

	/**
	 * Update both Sequence lifecycle flags as one transition. A sequence can
	 * move from premounting to postmounting (or the reverse) in one React
	 * commit. Applying the flags separately can briefly make the player look
	 * active and acquire a shared buffering lease in between the two updates.
	 */
	public setLifecycle({
		isPremounting,
		isPostmounting,
	}: {
		isPremounting: boolean;
		isPostmounting: boolean;
	}): void {
		if (
			this.isPremounting === isPremounting &&
			this.isPostmounting === isPostmounting
		) {
			return;
		}

		this.isPremounting = isPremounting;
		this.isPostmounting = isPostmounting;
		this.lifecycleVersion++;
		this.syncHandles(
			this.shouldDelayPlayback()
				? 'premounting-ended'
				: 'premounting-or-postmounting-started',
		);
	}

	public setIsPremounting(isPremounting: boolean): void {
		this.setLifecycle({
			isPremounting,
			isPostmounting: this.isPostmounting,
		});
	}

	public setIsPostmounting(isPostmounting: boolean): void {
		this.setLifecycle({
			isPremounting: this.isPremounting,
			isPostmounting,
		});
	}

	public createHandle(
		metadata?: DelayPlaybackMetadata,
	): DelayPlaybackIfNotPremounting {
		let armed = false;
		let unblock: ((reason?: string) => void) | null = null;
		let disposed = false;
		const premountingAtHandleCreation = this.isPremounting;
		const postmountingAtHandleCreation = this.isPostmounting;

		const arm = () => {
			// This check is deliberately repeated at acquisition time. A handle
			// can be created by an async iterator while its React component is
			// still in a premounting state.
			if (armed || disposed || !this.shouldDelayPlayback()) {
				return;
			}

			const metadataAtAcquisition: DelayPlaybackMetadata = {
				...this.baseMetadata,
				...(metadata ?? {}),
				// The lifecycle object is authoritative. Do not allow a stale
				// constructor snapshot supplied by baseMetadata to mislabel a
				// block, or to make later diagnostics look like a premount block.
				isPremounting: this.isPremounting,
				isPostmounting: this.isPostmounting,
				premountingAtHandleCreation,
				postmountingAtHandleCreation,
				premountLifecycleVersion: this.lifecycleVersion,
			};

			armed = true;
			try {
				unblock = this.delayPlayback(metadataAtAcquisition).unblock;
			} catch (error) {
				armed = false;
				throw error;
			}
		};

		const disarm = (reason?: string) => {
			if (!armed) {
				return;
			}

			unblock?.(reason);
			unblock = null;
			armed = false;
		};

		const entry: TrackedDelayHandle = {
			arm,
			disarm,
			dispose: () => {},
		};

		entry.dispose = () => {
			if (disposed) {
				return;
			}

			disposed = true;
			disarm('handle-disposed');
			this.activeHandles.delete(entry);
		};

		this.activeHandles.add(entry);

		if (this.shouldDelayPlayback()) {
			arm();
		}

		return {
			unblock: entry.dispose,
			[Symbol.dispose]: entry.dispose,
		};
	}
}
