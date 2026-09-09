import {
	AudioBufferSink,
	InputDisposedError,
	type InputAudioTrack,
} from 'mediabunny';
import type {LogLevel} from 'remotion';
import {Internals, type ScheduleAudioNodeResult} from 'remotion';
import {
	ALLOWED_GLOBAL_TIME_ANCHOR_SHIFT,
	isAlreadyQueued,
	makeAudioIterator,
	type AudioIterator,
	type QueuedPeriod,
} from './audio/audio-preview-iterator';
import {getScheduledTime} from './audio/get-scheduled-time';
import {pitchShiftAudioIterator} from './audio/pitch-shift';
import {
	GROUPED_AUDIO_SCHEDULER_CONCURRENCY,
	GROUPED_AUDIO_SCHEDULER_MAX_AHEAD_SECONDS,
	processNext,
	StaleWaiterError,
	waitForTurn,
} from './audio/sort-by-priority';
import type {
	DelayPlaybackIfNotPremounting,
	DelayPlaybackMetadata,
} from './delay-playback-if-not-premounting';
import {
	makeIteratorOverSourceRanges,
	makeIteratorWithPriming,
	makeLoopingIterator,
	type AudioBufferSlice,
	type AudioSourceRange,
} from './make-iterator-with-priming';
import type {Nonce} from './nonce-manager';
import type {SharedAudioContextForMediaPlayer} from './shared-audio-context-for-media-player';

type ScheduleAudioNode = (
	node: AudioBufferSourceNode,
	mediaTimestamp: number,
	originalUnloopedMediaTimestamp: number,
	sourceOffsetInSeconds: number,
	sourceDurationInSeconds: number,
) => ScheduleAudioNodeResult;

export const MINIMUM_AUDIO_BUFFERING_TIME_SECONDS = 0.1;

export const hasEnoughAudioToStartPlayback = (bufferedDuration: number) => {
	return bufferedDuration >= MINIMUM_AUDIO_BUFFERING_TIME_SECONDS;
};

export type AudioIteratorAnchor = {
	// The unlooped time in seconds at which the current iterator was started
	unloopedStartInSeconds: number;
	// The media timestamp emitted by the current iterator at that unlooped time
	mediaStartInSeconds: number;
};

// Convert an unlooped composition time into the iterator's continuous media
// timeline using the anchor established when the iterator was started. The
// looping iterator emits timestamps that continue monotonically across loop
// iterations, so both the scheduler (getTargetTime) and the seek dedup must
// map times into this same frame via the identical formula.
export const anchorToContinuousTime = ({
	anchor,
	unloopedTimeInSeconds,
	playbackRate,
}: {
	anchor: AudioIteratorAnchor;
	unloopedTimeInSeconds: number;
	playbackRate: number;
}): number => {
	return (
		anchor.mediaStartInSeconds +
		(unloopedTimeInSeconds - anchor.unloopedStartInSeconds) * playbackRate
	);
};

export const audioIteratorManager = ({
	audioTrack,
	delayPlaybackHandleIfNotPremounting,
	sharedAudioContext,
	getSequenceEndTimestamp,
	getSequenceDurationInSeconds,
	getMediaEndTimestamp,
	getStartTime,
	initialMuted,
	initialVolume,
	toneFrequency,
	drawDebugOverlay,
	mapAudioBufferSlice,
	audioSourceRanges,
	mapAudioSourceTimeToTimeline,
	maxAheadSeconds,
}: {
	audioTrack: InputAudioTrack;
	delayPlaybackHandleIfNotPremounting: (
		metadata?: DelayPlaybackMetadata,
	) => DelayPlaybackIfNotPremounting;
	sharedAudioContext: SharedAudioContextForMediaPlayer;
	getSequenceEndTimestamp: () => number;
	getSequenceDurationInSeconds: () => number;
	getMediaEndTimestamp: () => number;
	getStartTime: () => number;
	initialMuted: boolean;
	initialVolume: number;
	toneFrequency: number;
	drawDebugOverlay: () => void;
	mapAudioBufferSlice?: (
		slice: AudioBufferSlice,
	) => readonly AudioBufferSlice[];
	audioSourceRanges?: readonly AudioSourceRange[];
	mapAudioSourceTimeToTimeline?: (sourceTimeInSeconds: number) => number | null;
	maxAheadSeconds?: number | (() => number);
}) => {
	let muted = initialMuted;
	let currentVolume = Math.max(0, initialVolume);
	let currentToneFrequency = toneFrequency;
	let currentSeek: {
		time: number;
		playbackRate: number;
		trimBefore: number | undefined;
		trimAfter: number | undefined;
		sequenceOffset: number;
		sequenceDurationInFrames: number;
		loop: boolean;
		fps: number;
	} | null = null;

	const gainNode = sharedAudioContext.audioContext.createGain();
	gainNode.gain.value = muted ? 0 : currentVolume;
	gainNode.connect(sharedAudioContext.gainNode);

	const audioSink = new AudioBufferSink(audioTrack);
	let audioBufferIterator: AudioIterator | null = null;
	// When looping, the iterator emits timestamps that continue monotonically
	// across loop iterations instead of wrapping. This anchor maps the unlooped
	// time to that continuous timeline so the scheduler can align chunks.
	let currentAnchor: AudioIteratorAnchor | null = null;
	let audioIteratorsCreated = 0;
	let totalAudioScheduledInSeconds = 0;
	let audioChunksScheduled = 0;
	let audioChunksRejected = 0;
	let lastAudioChunkRejectionReason: string | null = null;
	let lastAudioChunkScheduledAtAudioTime: number | null = null;
	let lastAudioChunkScheduledSourceTime: number | null = null;
	let lastAudioChunkRejectedAtAudioTime: number | null = null;
	let audioSchedulingTurnsStarted = 0;
	let audioSchedulingTurnsCompleted = 0;
	let lastAudioTurnStartedAtAudioTime: number | null = null;
	let lastAudioTurnCompletedAtAudioTime: number | null = null;
	let currentIteratorStartFromSecond: number | null = null;
	let currentDelayHandle: {unblock: () => void} | null = null;

	const unblockCurrentDelayHandle = () => {
		if (currentDelayHandle) {
			currentDelayHandle.unblock();
			currentDelayHandle = null;
		}
	};

	const pendingScheduleWaiters: {
		remaining: number;
		resolve: () => void;
	}[] = [];

	const notifyNodeScheduled = () => {
		for (let i = pendingScheduleWaiters.length - 1; i >= 0; i--) {
			const waiter = pendingScheduleWaiters[i];
			waiter.remaining--;
			if (waiter.remaining <= 0) {
				waiter.resolve();
				pendingScheduleWaiters.splice(i, 1);
			}
		}
	};

	const waitForNScheduledNodes = (n: number) => {
		if (n <= 0) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			pendingScheduleWaiters.push({remaining: n, resolve});
		});
	};

	const scheduleAudioChunk = ({
		buffer,
		mediaTimestamp,
		originalUnloopedMediaTimestamp,
		sourceOffsetInSeconds,
		sourceDurationInSeconds,
		playbackRate,
		scheduleAudioNode,
		logLevel,
	}: {
		buffer: AudioBuffer;
		mediaTimestamp: number;
		playbackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		logLevel: LogLevel;
		originalUnloopedMediaTimestamp: number;
		sourceOffsetInSeconds: number;
		sourceDurationInSeconds: number;
	}): boolean => {
		if (!audioBufferIterator) {
			throw new Error('Audio buffer iterator not found');
		}

		if (muted) {
			return false;
		}

		const node = sharedAudioContext.audioContext.createBufferSource();
		node.buffer = buffer;
		node.playbackRate.value = playbackRate;
		node.connect(gainNode);

		const started = scheduleAudioNode(
			node,
			mediaTimestamp,
			originalUnloopedMediaTimestamp,
			sourceOffsetInSeconds,
			sourceDurationInSeconds,
		);

		if (started.type === 'not-started') {
			audioChunksRejected++;
			lastAudioChunkRejectionReason = started.reason;
			lastAudioChunkRejectedAtAudioTime =
				sharedAudioContext.audioContext.currentTime;
			Internals.Log.verbose(
				{logLevel, tag: 'audio-scheduling'},
				'not started, disconnected: %s %s',
				mediaTimestamp.toFixed(3),
				buffer.duration.toFixed(3),
			);

			node.disconnect();
			return false;
		}

		audioBufferIterator.addQueuedAudioNode({
			node,
			timestamp: mediaTimestamp,
			buffer,
			sourceDurationInSeconds,
			scheduledTime: started.scheduledTime,
			playbackRate,
			scheduledAtAnchor: sharedAudioContext.audioSyncAnchor.value,
		});
		audioChunksScheduled++;
		lastAudioChunkScheduledAtAudioTime =
			sharedAudioContext.audioContext.currentTime;
		lastAudioChunkScheduledSourceTime = mediaTimestamp;
		return true;
	};

	const onAudioChunk = ({
		buffer,
		playbackRate,
		scheduleAudioNode,
		logLevel,
	}: {
		buffer: AudioBufferSlice;
		playbackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		logLevel: LogLevel;
	}): boolean => {
		if (muted) {
			return false;
		}

		const startTime = getStartTime();
		const sequenceEndTime = getSequenceEndTimestamp();

		// Skip chunks entirely outside the range
		if (
			buffer.timelineTimestamp + buffer.sourceDurationInSeconds <=
			startTime
		) {
			return false;
		}

		if (buffer.timelineTimestamp >= sequenceEndTime) {
			return false;
		}

		// Source-range iterators yield source-order progress, including buffers that
		// fall entirely inside deleted gaps. The feed timeline mapper removes those
		// portions before an AudioBufferSourceNode is created.
		const slices = mapAudioBufferSlice ? mapAudioBufferSlice(buffer) : [buffer];
		let hasScheduledSlice = false;
		for (const slice of slices) {
			const sliceStart = Math.max(slice.timelineTimestamp, startTime);
			const sliceEnd = Math.min(
				slice.timelineTimestamp + slice.sourceDurationInSeconds,
				sequenceEndTime,
			);
			if (sliceEnd <= sliceStart) {
				continue;
			}

			const wasScheduled = scheduleAudioChunk({
				buffer: slice.buffer.buffer,
				mediaTimestamp: slice.timelineTimestamp,
				playbackRate,
				scheduleAudioNode,
				logLevel,
				originalUnloopedMediaTimestamp: slice.buffer.timestamp,
				sourceOffsetInSeconds: slice.sourceOffsetInSeconds,
				sourceDurationInSeconds: slice.sourceDurationInSeconds,
			});
			if (wasScheduled) {
				hasScheduledSlice = true;
				totalAudioScheduledInSeconds += Math.max(0, sliceEnd - sliceStart);
			}
		}

		drawDebugOverlay();
		return hasScheduledSlice;
	};

	const proceedScheduling = ({
		iterator,
		nonce,
		getTargetTime,
		playbackRate,
		scheduleAudioNode,
		onScheduled,
		onDestroyed,
		onDone,
		logLevel,
		getAudioContextCurrentTimeMockedInTest,
	}: {
		iterator: AudioIterator;
		nonce: Nonce;
		getTargetTime: (
			mediaTimestamp: number,
			currentTime: number,
		) => number | null;
		playbackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		onScheduled: (buffer: AudioBufferSlice) => void;
		onDone: () => void;
		onDestroyed: () => void;
		logLevel: LogLevel;
		getAudioContextCurrentTimeMockedInTest: () => number;
	}) => {
		waitForTurn({
			concurrency:
				audioSourceRanges === undefined
					? undefined
					: GROUPED_AUDIO_SCHEDULER_CONCURRENCY,
			maxAheadSeconds:
				audioSourceRanges === undefined
					? undefined
					: (maxAheadSeconds ?? GROUPED_AUDIO_SCHEDULER_MAX_AHEAD_SECONDS),
			getPriority: () => {
				if (iterator.isDestroyed()) {
					onDestroyed();
					return null;
				}

				const guessedNextTimestamp = iterator.guessNextTimestamp();
				// This manager can live for the entire duration of a feed. The priority
				// must be calculated against the current audio clock each time the
				// global queue asks for a turn; using the start-time snapshot makes a
				// long-lived iterator eventually look more than two seconds ahead and
				// stop scheduling.
				const currentTime = getAudioContextCurrentTimeMockedInTest();
				const targetTime = getTargetTime(guessedNextTimestamp, currentTime);
				if (targetTime === null) {
					// Time will not be mounted
					return null;
				}

				const scheduledTime = getScheduledTime({
					mediaTimestamp: guessedNextTimestamp,
					targetTime,
					currentTime,
					sequenceStartTime: getStartTime(),
				});

				return scheduledTime - currentTime;
			},
			fn: () => {
				audioSchedulingTurnsStarted++;
				lastAudioTurnStartedAtAudioTime =
					sharedAudioContext.audioContext.currentTime;
				return iterator.getNextFn();
			},
			onDone: (result, next) => {
				audioSchedulingTurnsCompleted++;
				lastAudioTurnCompletedAtAudioTime =
					sharedAudioContext.audioContext.currentTime;
				if (iterator.isDestroyed()) {
					next();
					onDestroyed();
					return;
				}

				// We schedule even if nonce.isStale(), because the iterator is still alive and the seek did not destroy the
				// iterator. So the seek was non-destructive, and the schedule valid. The iterator already progressed, we cannot get it again.

				if (!result.value) {
					// media ended
					next();
					onDone();
					return;
				}

				const hasAudibleSlice = onAudioChunk({
					buffer: result.value,
					playbackRate,
					scheduleAudioNode,
					logLevel,
				});
				if (hasAudibleSlice) {
					onScheduled(result.value);
					notifyNodeScheduled();
				}
				proceedScheduling({
					iterator,
					nonce,
					getTargetTime,
					playbackRate,
					scheduleAudioNode,
					onScheduled,
					onDestroyed,
					onDone,
					logLevel,
					getAudioContextCurrentTimeMockedInTest,
				});
				next();
			},
			onError: (e) => {
				audioSchedulingTurnsCompleted++;
				lastAudioTurnCompletedAtAudioTime =
					sharedAudioContext.audioContext.currentTime;
				if (e instanceof InputDisposedError) {
					// iterator was disposed by a newer startAudioIterator call
					// this is expected during rapid seeking
					onDestroyed();
					return;
				}

				if (e instanceof StaleWaiterError) {
					onDestroyed();
					// iterator was stale before it got its turn
					return;
				}

				throw e;
			},
		});
	};

	const startAudioIterator = ({
		nonce,
		playbackRate,
		startFromSecond,
		unloopedStartFromSecond,
		scheduleAudioNode,
		getTargetTime,
		logLevel,
		loop,
		unscheduleAudioNode,
		getAudioContextCurrentTimeMockedInTest,
	}: {
		startFromSecond: number;
		unloopedStartFromSecond: number;
		nonce: Nonce;
		playbackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		getTargetTime: (
			mediaTimestamp: number,
			currentTime: number,
		) => number | null;
		logLevel: LogLevel;
		loop: boolean;
		unscheduleAudioNode: (node: AudioBufferSourceNode) => void;
		getAudioContextCurrentTimeMockedInTest: () => number;
	}) => {
		if (muted) {
			return;
		}

		const maximumTimestamp = getMediaEndTimestamp();
		if (startFromSecond >= maximumTimestamp) {
			return;
		}

		audioBufferIterator?.destroy();
		unblockCurrentDelayHandle();

		const delayHandle = delayPlaybackHandleIfNotPremounting({
			operation: 'audio-decode-iterator',
			renderer: 'mediabunny-audio',
			mediaType: 'audio',
			reason: 'waiting-for-initial-audio-buffer',
			requestedTimeInSeconds: startFromSecond,
			unloopedTimeInSeconds: unloopedStartFromSecond,
		});
		currentDelayHandle = delayHandle;

		currentAnchor = {
			unloopedStartInSeconds: unloopedStartFromSecond,
			mediaStartInSeconds: startFromSecond,
		};
		currentIteratorStartFromSecond = startFromSecond;

		const maximumContinuousTimestamp =
			startFromSecond + getSequenceDurationInSeconds() * playbackRate;
		const unshiftedSource = loop
			? makeLoopingIterator({
					audioSink,
					seekTimeInSeconds: startFromSecond,
					loopStartInSeconds: getStartTime(),
					segmentEndInSeconds: maximumTimestamp,
					maximumContinuousTimestamp,
				})
			: audioSourceRanges !== undefined
				? makeIteratorOverSourceRanges({
						audioSink,
						timeToSeek: startFromSecond,
						maximumTimestamp,
						sourceRanges: audioSourceRanges,
					})
				: makeIteratorWithPriming({
						audioSink,
						timeToSeek: startFromSecond,
						maximumTimestamp,
					});
		const source = pitchShiftAudioIterator({
			iterator: unshiftedSource,
			toneFrequency: currentToneFrequency,
		});
		const iterator = makeAudioIterator({
			startFromSecond,
			iterator: source,
			unscheduleAudioNode,
		});
		audioIteratorsCreated++;
		audioBufferIterator = iterator;

		const startTimelineTime =
			mapAudioSourceTimeToTimeline?.(startFromSecond) ?? startFromSecond;
		let bufferedUntil = startTimelineTime;
		let hasUnblockedPlayback = false;
		const unblockPlayback = () => {
			if (hasUnblockedPlayback) {
				return;
			}

			hasUnblockedPlayback = true;
			delayHandle.unblock();
		};

		proceedScheduling({
			iterator,
			nonce,
			getTargetTime,
			playbackRate,
			scheduleAudioNode,
			onScheduled: (buffer) => {
				const sourceEnd =
					buffer.timelineTimestamp + buffer.sourceDurationInSeconds;
				const mappedTimelineEnd = mapAudioSourceTimeToTimeline?.(sourceEnd);
				const timelineEnd =
					mappedTimelineEnd ??
					(mapAudioSourceTimeToTimeline
						? getSequenceDurationInSeconds()
						: sourceEnd);
				bufferedUntil = Math.max(bufferedUntil, timelineEnd);
				const bufferedDuration = bufferedUntil - startTimelineTime;
				// Need to schedule a bit into the future to unblock the buffer state,
				// otherwise we might be scheduling too late. This must be based on
				// timeline coverage, not audible duration or chunk count: silence is
				// already safe to play, and large PCM chunks can exceed the scheduling
				// horizon before enough chunks are queued:
				// https://github.com/remotion-dev/remotion/issues/9394
				if (hasEnoughAudioToStartPlayback(bufferedDuration)) {
					unblockPlayback();
				}
			},
			onDestroyed: () => {
				unblockPlayback();
			},
			onDone: () => {
				unblockPlayback();
			},
			logLevel,
			getAudioContextCurrentTimeMockedInTest,
		});
	};

	const seek = ({
		newTime,
		unloopedNewTime,
		nonce,
		playbackRate,
		localPlaybackRate,
		scheduleAudioNode,
		getTargetTime,
		logLevel,
		loop,
		trimBefore,
		trimAfter,
		sequenceOffset,
		sequenceDurationInFrames,
		fps,
		getAudioContextCurrentTimeMockedInTest,
	}: {
		newTime: number;
		unloopedNewTime: number;
		nonce: Nonce;
		playbackRate: number;
		localPlaybackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		getTargetTime: (
			mediaTimestamp: number,
			currentTime: number,
		) => number | null;
		logLevel: LogLevel;
		loop: boolean;
		trimBefore: number | undefined;
		trimAfter: number | undefined;
		sequenceOffset: number;
		sequenceDurationInFrames: number;
		fps: number;
		getAudioContextCurrentTimeMockedInTest: () => number;
	}) => {
		if (nonce.isStale()) {
			return;
		}

		if (
			currentSeek !== null &&
			currentSeek.time === newTime &&
			currentSeek.playbackRate === playbackRate &&
			currentSeek.trimBefore === trimBefore &&
			currentSeek.trimAfter === trimAfter &&
			currentSeek.sequenceOffset === sequenceOffset &&
			currentSeek.sequenceDurationInFrames === sequenceDurationInFrames &&
			currentSeek.loop === loop &&
			currentSeek.fps === fps
		) {
			return;
		}

		currentSeek = {
			time: newTime,
			playbackRate,
			trimBefore,
			trimAfter,
			sequenceOffset,
			sequenceDurationInFrames,
			loop,
			fps,
		};

		if (muted) {
			return;
		}

		if (audioBufferIterator && !audioBufferIterator.isDestroyed()) {
			// When looping, queued nodes carry continuous timestamps that don't
			// wrap at loop boundaries. Map the new time into that continuous
			// frame so it can be compared against the queued period.
			const timeToCheck =
				loop && currentAnchor
					? anchorToContinuousTime({
							anchor: currentAnchor,
							unloopedTimeInSeconds: unloopedNewTime,
							playbackRate: localPlaybackRate,
						})
					: newTime;
			const queuedPeriod = audioBufferIterator.getQueuedPeriod();
			// If there is a missing period, but we'd have no chance to schedule nodes,
			// then let's not bother. Let's just leave the gap.
			const queuedPeriodMinusLatency: QueuedPeriod | null = queuedPeriod
				? {
						from:
							queuedPeriod.from -
							ALLOWED_GLOBAL_TIME_ANCHOR_SHIFT -
							sharedAudioContext.audioContext.baseLatency -
							sharedAudioContext.audioContext.outputLatency,
						until: queuedPeriod.until,
					}
				: null;
			const currentTimeIsAlreadyQueued = isAlreadyQueued(
				timeToCheck,
				queuedPeriodMinusLatency,
			);
			if (currentTimeIsAlreadyQueued) {
				processNext();
				// current time is scheduled, will keep scheduling
				return;
			}

			const currentIteratorTimestamp = audioBufferIterator.guessNextTimestamp();
			const mappedTimeToCheck =
				mapAudioSourceTimeToTimeline?.(timeToCheck) ?? timeToCheck;
			const mappedIteratorTimestamp =
				mapAudioSourceTimeToTimeline?.(currentIteratorTimestamp) ??
				currentIteratorTimestamp;
			const iteratorIsCloseBehind = mapAudioSourceTimeToTimeline
				? mappedIteratorTimestamp <= mappedTimeToCheck &&
					mappedTimeToCheck - mappedIteratorTimestamp < 1
				: currentIteratorTimestamp < timeToCheck &&
					Math.abs(currentIteratorTimestamp - timeToCheck) < 1;
			const iteratorHasAdvancedThroughSilence =
				loop &&
				currentAnchor !== null &&
				unloopedNewTime >= currentAnchor.unloopedStartInSeconds &&
				currentIteratorTimestamp >= timeToCheck;
			if (iteratorHasAdvancedThroughSilence || iteratorIsCloseBehind) {
				processNext();
				// The iterator has either advanced beyond the current time, meaning
				// the gap is known silence, or is less than 1 second behind. Let it run.
				return;
			}
		}

		startAudioIterator({
			nonce,
			playbackRate,
			startFromSecond: newTime,
			unloopedStartFromSecond: unloopedNewTime,
			scheduleAudioNode,
			getTargetTime,
			logLevel,
			loop,
			unscheduleAudioNode: sharedAudioContext.unscheduleAudioNode,
			getAudioContextCurrentTimeMockedInTest,
		});

		// Not further scheduling, initial iterator is already running
	};

	return {
		startAudioIterator,
		getAudioBufferIterator: () => audioBufferIterator,
		getCurrentAnchor: () => currentAnchor,
		destroyIterator: (stopAtTime?: number) => {
			audioBufferIterator?.destroy(stopAtTime);
			audioBufferIterator = null;
			currentIteratorStartFromSecond = null;
			// Drop the anchor together with the iterator it described, so
			// getCurrentAnchor() cannot hand out a stale mapping (from a previous
			// rate/trim) during the window before a new iterator is started.
			currentAnchor = null;
			currentSeek = null;
			unblockCurrentDelayHandle();
		},
		seek,
		getAudioIteratorsCreated: () => audioIteratorsCreated,
		getTotalAudioScheduledInSeconds: () => totalAudioScheduledInSeconds,
		getAudioChunksScheduled: () => audioChunksScheduled,
		getAudioChunksRejected: () => audioChunksRejected,
		getLastAudioChunkRejectionReason: () => lastAudioChunkRejectionReason,
		getLastAudioChunkScheduledAtAudioTime: () =>
			lastAudioChunkScheduledAtAudioTime,
		getLastAudioChunkScheduledSourceTime: () =>
			lastAudioChunkScheduledSourceTime,
		getLastAudioChunkRejectedAtAudioTime: () =>
			lastAudioChunkRejectedAtAudioTime,
		getAudioSchedulingTurnsStarted: () => audioSchedulingTurnsStarted,
		getAudioSchedulingTurnsCompleted: () => audioSchedulingTurnsCompleted,
		getLastAudioTurnStartedAtAudioTime: () => lastAudioTurnStartedAtAudioTime,
		getLastAudioTurnCompletedAtAudioTime: () =>
			lastAudioTurnCompletedAtAudioTime,
		getCurrentIteratorStartFromSecond: () => currentIteratorStartFromSecond,
		setMuted: (newMuted: boolean) => {
			muted = newMuted;
			gainNode.gain.value = muted ? 0 : currentVolume;
		},
		setVolume: (volume: number) => {
			currentVolume = Math.max(0, volume);
			gainNode.gain.value = muted ? 0 : currentVolume;
		},
		setToneFrequency: (newToneFrequency: number) => {
			currentToneFrequency = newToneFrequency;
		},
		scheduleAudioChunk,
		waitForNScheduledNodes,
	};
};

export type AudioIteratorManager = ReturnType<typeof audioIteratorManager>;
