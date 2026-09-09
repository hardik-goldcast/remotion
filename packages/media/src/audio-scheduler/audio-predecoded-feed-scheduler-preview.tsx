import type React from 'react';
import {useContext, useEffect, useLayoutEffect, useRef} from 'react';
import {Internals, useCurrentFrame, useVideoConfig} from 'remotion';
import type {PredecodedAudioWindow} from '../audio/predecode-audio-window';
import {getAudioSchedulerQueueDiagnostics} from '../audio/sort-by-priority';
import {MediaPlayer} from '../media-player';
import type {SharedAudioContextForMediaPlayer} from '../shared-audio-context-for-media-player';
import {makeAudioFeedTimeline} from './audio-scheduler-audio-timeline';
import {scheduleAudioFeedPlanGain} from './audio-scheduler-gain';
import {clampAudioSchedulerTime} from './audio-scheduler-timeline';
import type {NormalizedAudioFeedPlan} from './audio-scheduler-types';

const {SetTimelineContext, SharedAudioContext, SequenceContext} = Internals;

const NO_OP_BUFFER_STATE = {
	delayPlayback: () => ({unblock: () => {}}),
};

const AUDIO_SCHEDULER_IMPLEMENTATION_VERSION =
	'feed-v2-single-feed-spoorthi-predecode-60s';
const AUDIO_SCHEDULER_DIAGNOSTIC_KEY = 'KeyL';
const AUDIO_SCHEDULER_DIAGNOSTIC_HISTORY_LIMIT = 180;
const PREDECODE_WINDOW_SECONDS = 60;
const PREDECODE_START_LEAD_SECONDS = 0.05;

type PredecodeSharedAudioContext = Pick<
	SharedAudioContextForMediaPlayer,
	| 'audioContext'
	| 'audioSyncAnchor'
	| 'scheduleAudioNode'
	| 'unscheduleAudioNode'
>;

type FrameRef = {current: number};

const getGlobalFeedOffsetSeconds = (schedulerStartTimeInSeconds: number) =>
	schedulerStartTimeInSeconds;

const getPlayerLocalTime = ({
	globalCompositionTime,
	plan,
	schedulerStartTimeInSeconds,
	fps,
}: {
	globalCompositionTime: number;
	plan: NormalizedAudioFeedPlan;
	schedulerStartTimeInSeconds: number;
	fps: number;
}) => {
	return clampAudioSchedulerTime({
		durationInSeconds: plan.durationInSeconds,
		timeInSeconds:
			globalCompositionTime -
			getGlobalFeedOffsetSeconds(schedulerStartTimeInSeconds),
		fps,
	});
};

type PredecodeState =
	| 'initializing'
	| 'decoding'
	| 'ready'
	| 'scheduled'
	| 'ended'
	| 'error';

type PredecodedPlayerSlot = {
	player: MediaPlayer;
	gainNode: GainNode;
	plan: NormalizedAudioFeedPlan;
	window: PredecodedAudioWindow | null;
	state: PredecodeState;
	sourceNode: AudioBufferSourceNode | null;
	scheduledTime: number | null;
	sourceOffset: number | null;
	predecodeStartedAtWallTime: number | null;
	predecodeFinishedAtWallTime: number | null;
	predecodeError: string | null;
	disposed: boolean;
};

type PredecodedFeedRuntime = {
	trackId: string;
	state: PredecodeState;
	requestedCompositionSeconds: number;
	decodedCompositionSeconds: number;
	decodedSourceStartSeconds: number | null;
	decodedSourceEndSeconds: number | null;
	decodedBufferCount: number;
	selectedSliceCount: number;
	selectedAudioDurationSeconds: number;
	bufferDurationSeconds: number;
	predecodeElapsedMs: number | null;
	sourceNodeScheduled: boolean;
	scheduledTime: number | null;
	sourceOffset: number | null;
	error: string | null;
};

type PredecodedSchedulerRuntime = {
	version: string;
	frame: number;
	audioContext: {
		state: string;
		time: number;
		baseLatency: number;
		outputLatency: number;
		masterGain: number | null;
		anchor: number;
		globalCompositionTime: number;
		audioClockMinusTimeline: number;
	};
	queue: ReturnType<typeof getAudioSchedulerQueueDiagnostics>;
	prebuffering: boolean;
	feed: PredecodedFeedRuntime | null;
};

const getPredecodeRuntime = (
	slot: PredecodedPlayerSlot | null,
	requestedCompositionSeconds: number,
): PredecodedFeedRuntime | null => {
	if (!slot) {
		return null;
	}

	const predecoded = slot.window;
	return {
		trackId: slot.plan.trackId,
		state: slot.state,
		requestedCompositionSeconds,
		decodedCompositionSeconds: predecoded
			? predecoded.toCompositionTimeInSeconds -
				predecoded.fromCompositionTimeInSeconds
			: 0,
		decodedSourceStartSeconds: predecoded?.sourceStartTimeInSeconds ?? null,
		decodedSourceEndSeconds: predecoded?.decodedSourceUntilInSeconds ?? null,
		decodedBufferCount: predecoded?.decodedBufferCount ?? 0,
		selectedSliceCount: predecoded?.selectedSliceCount ?? 0,
		selectedAudioDurationSeconds:
			predecoded?.selectedAudioDurationInSeconds ?? 0,
		bufferDurationSeconds: predecoded?.buffer.duration ?? 0,
		predecodeElapsedMs:
			slot.predecodeStartedAtWallTime !== null &&
			slot.predecodeFinishedAtWallTime !== null
				? slot.predecodeFinishedAtWallTime - slot.predecodeStartedAtWallTime
				: null,
		sourceNodeScheduled: slot.sourceNode !== null,
		scheduledTime: slot.scheduledTime,
		sourceOffset: slot.sourceOffset,
		error: slot.predecodeError,
	};
};

/**
 * Diagnostic scheduler that removes live chunk scheduling from the first
 * minute of playback. It decodes a continuous source window, compacts the
 * selected ranges into one AudioBuffer, and only then schedules one source.
 */
export const AudioPredecodedFeedSchedulerPreview: React.FC<{
	readonly plans: readonly NormalizedAudioFeedPlan[];
}> = ({plans}) => {
	const sharedAudioContext = useContext(SharedAudioContext);
	const {setBuffering, isBuffering, isPlaying, subscribePlaying} =
		useContext(SetTimelineContext);
	const {fps} = useVideoConfig();
	const frame = useCurrentFrame();
	const logLevel = Internals.useLogLevel();
	const frameRef = useRef(frame);
	frameRef.current = frame;

	const parentSequence = useContext(SequenceContext);
	const schedulerStartTimeInSeconds = (parentSequence?.absoluteFrom ?? 0) / fps;

	const slotsRef = useRef<Map<string, PredecodedPlayerSlot>>(new Map());
	const lastDiagnosticsAudioTimeRef = useRef(-Infinity);
	const runtimeHistoryRef = useRef<PredecodedSchedulerRuntime[]>([]);
	const anchorEventsRef = useRef<
		{
			frame: number;
			audioTime: number;
			globalCompositionTime: number;
			previousAnchor: number;
			nextAnchor: number;
			shift: number;
		}[]
	>([]);
	const lastObservedAnchorRef = useRef<number | null>(null);

	const applyGainEnvelope = (
		gainNode: GainNode,
		plan: NormalizedAudioFeedPlan,
		audioSyncAnchor: {readonly value: number},
		audioContext: AudioContext,
		audioContextCurrentTime = audioContext.currentTime,
	) => {
		scheduleAudioFeedPlanGain({
			gainNode,
			plan,
			schedulerStartTimeInSeconds,
			audioSyncAnchor,
			audioContextCurrentTime,
		});
	};

	useEffect(() => {
		const handleDiagnosticKeyDown = (event: KeyboardEvent) => {
			if (
				event.repeat ||
				!event.altKey ||
				!event.shiftKey ||
				event.code !== AUDIO_SCHEDULER_DIAGNOSTIC_KEY
			) {
				return;
			}

			event.preventDefault();
			const dump = {
				version: AUDIO_SCHEDULER_IMPLEMENTATION_VERSION,
				capturedAt: new Date().toISOString(),
				sampleCount: runtimeHistoryRef.current.length,
				anchorEvents: anchorEventsRef.current,
				samples: runtimeHistoryRef.current,
			};

			console.info(
				'[AudioScheduler] collected predecoded feed runtime dump',
				JSON.stringify(dump),
			);
		};

		window.addEventListener('keydown', handleDiagnosticKeyDown);
		return () => {
			window.removeEventListener('keydown', handleDiagnosticKeyDown);
		};
	}, []);

	useEffect(() => {
		if (
			!sharedAudioContext?.audioContext ||
			!sharedAudioContext.gainNode ||
			plans.length !== 1
		) {
			return;
		}

		runtimeHistoryRef.current = [];
		lastDiagnosticsAudioTimeRef.current = -Infinity;
		anchorEventsRef.current = [];
		lastObservedAnchorRef.current = null;

		const {
			audioContext,
			gainNode: masterGainNode,
			audioSyncAnchor,
			scheduleAudioNode,
			unscheduleAudioNode,
		} = sharedAudioContext;
		const plan = plans[0];
		const timeline = makeAudioFeedTimeline(plan);
		const slots = new Map<string, PredecodedPlayerSlot>();
		const isDisposed = {value: false};
		const ownsBuffering = {value: true};
		slotsRef.current = slots;

		setBuffering(true);

		const releaseBuffering = () => {
			if (!ownsBuffering.value) {
				return;
			}

			ownsBuffering.value = false;
			setBuffering(false);
		};

		const stopSourceNode = (slot: PredecodedPlayerSlot) => {
			const sourceNode = slot.sourceNode;
			if (!sourceNode) {
				return;
			}

			unscheduleAudioNode(sourceNode);
			sourceNode.onended = null;
			try {
				sourceNode.stop();
			} catch {
				// The source may not have started yet or may already have ended.
			}
			sourceNode.disconnect();
			slot.sourceNode = null;
			slot.scheduledTime = null;
			slot.sourceOffset = null;
		};

		const disposeSlot = (slot: PredecodedPlayerSlot) => {
			if (slot.disposed) {
				return;
			}

			slot.disposed = true;
			stopSourceNode(slot);
			slot.gainNode.gain.cancelScheduledValues(audioContext.currentTime);
			slot.gainNode.gain.setValueAtTime(0, audioContext.currentTime);
			slot.gainNode.disconnect();
			slot.player.dispose().catch(() => {});
		};

		const startSourceNode = (slot: PredecodedPlayerSlot) => {
			if (
				isDisposed.value ||
				slot.disposed ||
				slot.state !== 'ready' ||
				!slot.window ||
				!isPlaying() ||
				isBuffering()
			) {
				return;
			}

			const currentGlobalTime =
				schedulerStartTimeInSeconds + frameRef.current / fps;
			const currentLocalTime = getPlayerLocalTime({
				globalCompositionTime: currentGlobalTime,
				plan: slot.plan,
				schedulerStartTimeInSeconds,
				fps,
			});
			const sourceOffset = Math.max(
				0,
				Math.min(
					slot.window.buffer.duration,
					currentLocalTime - slot.window.fromCompositionTimeInSeconds,
				),
			);
			const duration = slot.window.buffer.duration - sourceOffset;
			if (duration <= 0) {
				slot.state = 'ended';
				return;
			}

			const now = audioContext.currentTime;
			const desiredStartTime =
				audioSyncAnchor.value +
				schedulerStartTimeInSeconds +
				slot.window.fromCompositionTimeInSeconds +
				(currentLocalTime - slot.window.fromCompositionTimeInSeconds);
			const scheduledTime = Math.max(
				now + PREDECODE_START_LEAD_SECONDS,
				desiredStartTime,
			);

			const sourceNode = audioContext.createBufferSource();
			sourceNode.buffer = slot.window.buffer;
			sourceNode.connect(slot.gainNode);
			const result = scheduleAudioNode({
				node: sourceNode,
				mediaTimestamp: currentLocalTime,
				originalUnloopedMediaTimestamp: currentLocalTime,
				sourceOffset: 0,
				scheduledTime,
				duration,
				offset: sourceOffset,
			});

			if (result.type === 'not-started') {
				sourceNode.disconnect();
				slot.state = 'error';
				slot.predecodeError =
					'predecoded source could not be scheduled: ' + result.reason;
				console.error('[AudioScheduler] PREBUFFER_SCHEDULE_FAILED', {
					version: AUDIO_SCHEDULER_IMPLEMENTATION_VERSION,
					reason: result.reason,
					currentGlobalTime,
					currentLocalTime,
					now,
					scheduledTime,
					sourceOffset,
				});
				return;
			}

			slot.sourceNode = sourceNode;
			slot.scheduledTime = result.scheduledTime;
			slot.sourceOffset = sourceOffset;
			slot.state = 'scheduled';
			sourceNode.onended = () => {
				if (slot.sourceNode !== sourceNode || slot.disposed) {
					return;
				}

				slot.sourceNode = null;
				slot.state = 'ended';
			};

			applyGainEnvelope(
				slot.gainNode,
				slot.plan,
				audioSyncAnchor,
				audioContext,
				Math.max(now, result.scheduledTime),
			);

		};

		const scheduleWhenPossible = () => {
			const slot = slots.get(plan.trackId);
			if (!slot || slot.state !== 'ready' || !isPlaying() || isBuffering()) {
				return;
			}

			// Let the player finish its resume/anchor transaction before asking the
			// shared scheduler to start the diagnostic source.
			setTimeout(() => startSourceNode(slot), 0);
		};

		const gainNode = audioContext.createGain();
		gainNode.gain.value = 0;
		gainNode.connect(masterGainNode);
		const player = new MediaPlayer({
			canvas: null,
			src: plan.previewSrc,
			logLevel,
			// This MediaPlayer is a decoder helper only. The live audio iterator is
			// deliberately not created; the predecoded AudioBuffer is scheduled below.
			sharedAudioContext: null,
			loop: false,
			trimBefore: undefined,
			trimAfter: undefined,
			playbackRate: 1,
			toneFrequency: 1,
			globalPlaybackRate: 1,
			audioStreamIndex: null,
			fps,
			debugOverlay: false,
			bufferState: NO_OP_BUFFER_STATE,
			isPremounting: false,
			isPostmounting: false,
			durationInFrames: plan.durationInSeconds * fps,
			onVideoFrameCallback: null,
			playing: false,
			sequenceOffset: schedulerStartTimeInSeconds,
			credentials: undefined,
			requestInit: undefined,
			tagType: 'audio',
			getEffects: () => [],
			getEffectChainState: () => null,
			audioTimeline: timeline,
		});

		const slot: PredecodedPlayerSlot = {
			player,
			gainNode,
			plan,
			window: null,
			state: 'initializing',
			sourceNode: null,
			scheduledTime: null,
			sourceOffset: null,
			predecodeStartedAtWallTime: null,
			predecodeFinishedAtWallTime: null,
			predecodeError: null,
			disposed: false,
		};
		slots.set(plan.trackId, slot);

		const initializeAndPredecode = async () => {
			try {
				const initialLocalTime = getPlayerLocalTime({
					globalCompositionTime:
						schedulerStartTimeInSeconds + frameRef.current / fps,
					plan,
					schedulerStartTimeInSeconds,
					fps,
				});
				const result = await player.initialize(initialLocalTime, false, 1);
				if (result.type !== 'success') {
					throw new Error('decoder initialization returned ' + result.type);
				}

				slot.state = 'decoding';
				slot.predecodeStartedAtWallTime = performance.now();

				const predecodedWindow = await player.predecodeAudioWindow({
					fromCompositionTimeInSeconds: 0,
					toCompositionTimeInSeconds: Math.min(
						PREDECODE_WINDOW_SECONDS,
						plan.durationInSeconds,
					),
				});
				slot.window = predecodedWindow;
				slot.predecodeFinishedAtWallTime = performance.now();
				slot.state = 'ready';
				const predecodeFinishedAtWallTime = slot.predecodeFinishedAtWallTime;
				if (
					predecodeFinishedAtWallTime === null ||
					slot.predecodeStartedAtWallTime === null
				) {
					throw new Error('Predecode completed without timing metadata.');
				}

				releaseBuffering();
				scheduleWhenPossible();
			} catch (error) {
				if (isDisposed.value || slot.disposed) {
					return;
				}

				slot.state = 'error';
				slot.predecodeFinishedAtWallTime = performance.now();
				slot.predecodeError =
					error instanceof Error ? error.message : String(error);
				console.error('[AudioScheduler] PREBUFFER_FAILED', {
					version: AUDIO_SCHEDULER_IMPLEMENTATION_VERSION,
					trackId: plan.trackId,
					error,
				});
				releaseBuffering();
			}
		};

		initializeAndPredecode();

		const unsubscribePlaying = subscribePlaying(() => {
			scheduleWhenPossible();
		});

		return () => {
			isDisposed.value = true;
			unsubscribePlaying();
			if (ownsBuffering.value) {
				releaseBuffering();
			}
			disposeSlot(slot);
			slots.clear();
			if (slotsRef.current === slots) {
				slotsRef.current = new Map();
			}
		};
		// This diagnostic intentionally creates one decoder helper for the mounted
		// plan and does not recreate it on every frame.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		fps,
		logLevel,
		plans,
		schedulerStartTimeInSeconds,
		setBuffering,
		sharedAudioContext,
		subscribePlaying,
	]);

	useLayoutEffect(() => {
		if (!sharedAudioContext?.audioContext) {
			return;
		}

		const {audioContext, audioSyncAnchor, audioSyncAnchorEmitter} =
			sharedAudioContext;
		const predecodeSharedAudioContext: PredecodeSharedAudioContext = {
			audioContext,
			audioSyncAnchor,
			scheduleAudioNode: sharedAudioContext.scheduleAudioNode,
			unscheduleAudioNode: sharedAudioContext.unscheduleAudioNode,
		};
		lastObservedAnchorRef.current = audioSyncAnchor.value;
		const {remove} = audioSyncAnchorEmitter.subscribe((event) => {
			if (event !== 'changed') {
				return;
			}

			const currentGlobalTime =
				schedulerStartTimeInSeconds + frameRef.current / fps;
			const previousAnchor =
				lastObservedAnchorRef.current ?? audioSyncAnchor.value;
			const nextAnchor = audioSyncAnchor.value;
			lastObservedAnchorRef.current = nextAnchor;
			anchorEventsRef.current.push({
				frame: frameRef.current,
				audioTime: audioContext.currentTime,
				globalCompositionTime: currentGlobalTime,
				previousAnchor,
				nextAnchor,
				shift: nextAnchor - previousAnchor,
			});
			if (anchorEventsRef.current.length > 64) {
				anchorEventsRef.current.splice(0, anchorEventsRef.current.length - 64);
			}

			for (const slot of slotsRef.current.values()) {
				if (slot.sourceNode) {
					stopPredecodedSourceForAnchorChange(
						slot,
						predecodeSharedAudioContext,
					);
				}
			}

			setTimeout(() => {
				const slot = slotsRef.current.values().next().value as
					| PredecodedPlayerSlot
					| undefined;
				if (slot && slot.state === 'ready' && isPlaying() && !isBuffering()) {
					startPredecodedSourceAfterAnchorChange(
						slot,
						predecodeSharedAudioContext,
						{
							fps,
							schedulerStartTimeInSeconds,
							frameRef,
						},
					);
				}
			}, 0);
		});

		return remove;
	}, [
		fps,
		isBuffering,
		isPlaying,
		schedulerStartTimeInSeconds,
		sharedAudioContext,
	]);

	useLayoutEffect(() => {
		if (!sharedAudioContext?.audioContext || plans.length !== 1) {
			return;
		}

		const audioTime = sharedAudioContext.audioContext.currentTime;
		if (audioTime - lastDiagnosticsAudioTimeRef.current < 1) {
			return;
		}
		lastDiagnosticsAudioTimeRef.current = audioTime;

		const currentGlobalTime = schedulerStartTimeInSeconds + frame / fps;
		const slot = slotsRef.current.values().next().value as
			| PredecodedPlayerSlot
			| undefined;
		const requestedCompositionSeconds = Math.min(
			PREDECODE_WINDOW_SECONDS,
			Math.max(0, currentGlobalTime - schedulerStartTimeInSeconds),
		);
		const runtime: PredecodedSchedulerRuntime = {
			version: AUDIO_SCHEDULER_IMPLEMENTATION_VERSION,
			frame,
			audioContext: {
				state: sharedAudioContext.audioContext.state,
				time: audioTime,
				baseLatency: sharedAudioContext.audioContext.baseLatency,
				outputLatency: sharedAudioContext.audioContext.outputLatency,
				masterGain: sharedAudioContext.gainNode?.gain.value ?? null,
				anchor: sharedAudioContext.audioSyncAnchor.value,
				globalCompositionTime: currentGlobalTime,
				audioClockMinusTimeline: audioTime - currentGlobalTime,
			},
			queue: getAudioSchedulerQueueDiagnostics(),
			prebuffering: isBuffering(),
			feed: getPredecodeRuntime(slot ?? null, requestedCompositionSeconds),
		};
		runtimeHistoryRef.current.push(runtime);
		if (
			runtimeHistoryRef.current.length >
			AUDIO_SCHEDULER_DIAGNOSTIC_HISTORY_LIMIT
		) {
			runtimeHistoryRef.current.splice(
				0,
				runtimeHistoryRef.current.length -
					AUDIO_SCHEDULER_DIAGNOSTIC_HISTORY_LIMIT,
			);
		}

	}, [
		fps,
		frame,
		isBuffering,
		plans.length,
		schedulerStartTimeInSeconds,
		sharedAudioContext,
	]);

	return null;
};

const stopPredecodedSourceForAnchorChange = (
	slot: PredecodedPlayerSlot,
	sharedAudioContext: PredecodeSharedAudioContext,
) => {
	const sourceNode = slot.sourceNode;
	if (!sourceNode || !sharedAudioContext) {
		return;
	}

	sharedAudioContext.unscheduleAudioNode(sourceNode);
	sourceNode.onended = null;
	try {
		sourceNode.stop();
	} catch {
		// The source may have ended between the anchor event and cleanup.
	}
	sourceNode.disconnect();
	slot.sourceNode = null;
	slot.scheduledTime = null;
	slot.sourceOffset = null;
	slot.state = 'ready';
};

const startPredecodedSourceAfterAnchorChange = (
	slot: PredecodedPlayerSlot,
	sharedAudioContext: PredecodeSharedAudioContext,
	{
		fps,
		schedulerStartTimeInSeconds,
		frameRef,
	}: {
		fps: number;
		schedulerStartTimeInSeconds: number;
		frameRef: FrameRef;
	},
) => {
	if (!slot.window || !sharedAudioContext || slot.disposed) {
		return;
	}

	const audioContext = sharedAudioContext.audioContext;
	const currentGlobalTime =
		schedulerStartTimeInSeconds + frameRef.current / fps;
	const currentLocalTime = getPlayerLocalTime({
		globalCompositionTime: currentGlobalTime,
		plan: slot.plan,
		schedulerStartTimeInSeconds,
		fps,
	});
	const sourceOffset = Math.max(
		0,
		Math.min(
			slot.window.buffer.duration,
			currentLocalTime - slot.window.fromCompositionTimeInSeconds,
		),
	);
	const duration = slot.window.buffer.duration - sourceOffset;
	if (duration <= 0) {
		slot.state = 'ended';
		return;
	}

	const now = audioContext.currentTime;
	const scheduledTime = now + PREDECODE_START_LEAD_SECONDS;
	const sourceNode = audioContext.createBufferSource();
	sourceNode.buffer = slot.window.buffer;
	sourceNode.connect(slot.gainNode);
	const result = sharedAudioContext.scheduleAudioNode({
		node: sourceNode,
		mediaTimestamp: currentLocalTime,
		originalUnloopedMediaTimestamp: currentLocalTime,
		sourceOffset: 0,
		scheduledTime,
		duration,
		offset: sourceOffset,
	});
	if (result.type === 'not-started') {
		sourceNode.disconnect();
		slot.state = 'error';
		slot.predecodeError =
			'predecoded source could not be rescheduled: ' + result.reason;
		return;
	}

	slot.sourceNode = sourceNode;
	slot.scheduledTime = result.scheduledTime;
	slot.sourceOffset = sourceOffset;
	slot.state = 'scheduled';
	sourceNode.onended = () => {
		if (slot.sourceNode === sourceNode) {
			slot.sourceNode = null;
			slot.state = 'ended';
		}
	};
	scheduleAudioFeedPlanGain({
		gainNode: slot.gainNode,
		plan: slot.plan,
		schedulerStartTimeInSeconds,
		audioSyncAnchor: sharedAudioContext.audioSyncAnchor,
		audioContextCurrentTime: Math.max(now, result.scheduledTime),
	});
};
