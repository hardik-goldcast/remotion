import type React from 'react';
import {useContext, useEffect, useLayoutEffect, useMemo, useRef} from 'react';
import {
	Internals,
	useBufferState,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion';
import type {AudioTimeline} from '../audio/audio-timeline';
import {getAudioSchedulerQueueDiagnostics} from '../audio/sort-by-priority';
import {MediaPlayer} from '../media-player';
import type {SharedAudioContextForMediaPlayer} from '../shared-audio-context-for-media-player';
import {
	resolveAudioFeedSchedulerConfig,
	type AudioFeedSchedulerConfig,
	type AudioFeedSchedulerConfigOverrides,
} from './audio-feed-scheduler-config';
import {makeAudioFeedTimeline} from './audio-scheduler-audio-timeline';
import {scheduleAudioFeedPlanGain} from './audio-scheduler-gain';
import {
	clampAudioSchedulerTime,
	isAudioSchedulerEntryInWindow,
} from './audio-scheduler-timeline';
import type {NormalizedAudioFeedPlan} from './audio-scheduler-types';

const {SetTimelineContext, SharedAudioContext, SequenceContext} = Internals;

const NO_OP_BUFFER_STATE = {
	delayPlayback: () => ({unblock: () => {}}),
};

const AUDIO_SCHEDULER_SEEK_FADE_SECONDS = 0.01;
const AUDIO_SCHEDULER_GAIN_GUARD_SECONDS = 0.001;
const AUDIO_SCHEDULER_IMPLEMENTATION_VERSION =
	'feed-v10-remotion-buffer-plus-active-audio';
const AUDIO_SCHEDULER_DIAGNOSTIC_KEY = 'KeyL';
const AUDIO_SCHEDULER_DIAGNOSTIC_HISTORY_LIMIT = 180;
const AUDIO_SCHEDULER_BUFFERING_TRANSITION_HISTORY_LIMIT = 512;
const AUDIO_SCHEDULER_AUDIO_CONTEXT_HISTORY_LIMIT = 256;
const AUDIO_SCHEDULER_FRAME_STALL_HISTORY_LIMIT = 512;
const AUDIO_SCHEDULER_FRAME_STALL_THRESHOLD_MS = 50;
const AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS = 0.02;
const AUDIO_SCHEDULER_BUFFERING_SAFETY_SECONDS = 0.25;

const getGlobalFeedOffsetSeconds = (schedulerStartTimeInSeconds: number) =>
	schedulerStartTimeInSeconds;

const getFeedStartTimeInSeconds = (plan: NormalizedAudioFeedPlan) => {
	return plan.ranges[0]?.startTimeInSeconds ?? 0;
};

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

type PlayerSlot = {
	player: MediaPlayer;
	gainNode: GainNode;
	plan: NormalizedAudioFeedPlan;
	timeline: AudioTimeline;
	disposed: boolean;
};

type AudioSchedulerController = {
	syncToTime: (currentGlobalTime: number) => void;
};

type AudioSchedulerFeedRuntime = {
	trackId: string;
	localTime: number;
	queuedNodeCount: number;
	queuedSourceFrom: number | null;
	queuedSourceUntil: number | null;
	queuedCompositionUntil: number | null;
	nextSourceTime: number | null;
	nextCompositionTime: number | null;
	compositionAhead: number | null;
	iteratorCount: number;
	iteratorStartSource: number | null;
	schedulingTurnsStarted: number;
	schedulingTurnsCompleted: number;
	lastTurnStartedAtAudioTime: number | null;
	lastTurnCompletedAtAudioTime: number | null;
	chunksScheduled: number;
	rejectedChunks: number;
	lastRejectReason: string | null;
	lastChunkScheduledAtAudioTime: number | null;
	lastChunkScheduledSourceTime: number | null;
	lastChunkRejectedAtAudioTime: number | null;
	scheduledSeconds: number;
	feedGain: number;
	diagnosis: string;
};

type AudioFeedBufferHealth = {
	trackId: string;
	currentLocalTime: number;
	nextAudioStartTime: number | null;
	timeToNextAudio: number | null;
	queuedCompositionFrom: number | null;
	queuedCompositionUntil: number | null;
	compositionAhead: number | null;
	requiredForPlayback: boolean;
	requiredForStartup: boolean;
	requiredForRecovery: boolean;
	healthyForStartup: boolean;
	atRisk: boolean;
	healthyForRecovery: boolean;
	reason: string;
};

type AudioSchedulerBufferingStatus = {
	active: boolean;
	reason: string | null;
	affectedFeedIds: string[];
	minimumAheadSeconds: number | null;
	bufferingPositionGlobalTime: number | null;
	bufferingTargetGlobalTime: number | null;
	currentAudioGlobalTime: number | null;
	currentVideoGlobalTime: number | null;
	audioVideoDriftSeconds: number | null;
	startupReady: boolean;
	schedulerGateOpen: boolean;
};

type AudioSchedulerOutputState = {
	audioContextState: string;
	remotionAudioContextState: string | null;
	audioContextTime: number;
	audioSyncAnchor: number;
	masterGain: number | null;
	schedulerGateGain: number;
	providerBuffering: boolean;
	bufferingOwner: boolean;
	bufferingHandleAcquired: boolean;
	queuedNodeCount: number;
	minimumFeedGain: number | null;
	maximumFeedGain: number | null;
};

type AudioSchedulerBufferingWatchdog = {
	wallTimeMs: number;
	reason: string | null;
	isPlaying: boolean;
	isBuffering: boolean;
	currentAudioGlobalTime: number;
	currentVideoGlobalTime: number;
	audioVideoDriftSeconds: number;
	minimumAheadSeconds: number | null;
	allFeedsRecovered: boolean;
	queue: ReturnType<typeof getAudioSchedulerQueueDiagnostics>;
	output: AudioSchedulerOutputState;
	healthSummary: {
		recoveryReadyCount: number;
		startupReadyCount: number;
		atRiskCount: number;
		reasonCounts: Record<string, number>;
	};
	feeds: Array<{
		trackId: string;
		queuedNodeCount: number;
		queuedCompositionFrom: number | null;
		queuedCompositionUntil: number | null;
		compositionAhead: number | null;
		reason: string;
		iteratorCount: number;
		schedulingTurnsStarted: number;
		schedulingTurnsCompleted: number;
		chunksScheduled: number;
		rejectedChunks: number;
		lastRejectReason: string | null;
		scheduledSeconds: number;
	}>;
};

type AudioSchedulerBufferingEvent = {
	type: 'entered' | 'recovered' | 'cancelled';
	wallTimeMs: number;
	audioTime: number;
	currentAudioGlobalTime: number | null;
	currentVideoGlobalTime: number | null;
	audioVideoDriftSeconds: number | null;
	reason: string | null;
	affectedFeedIds: string[];
	minimumAheadSeconds: number | null;
	health: AudioFeedBufferHealth[];
	outputBefore: AudioSchedulerOutputState | null;
	outputAfter: AudioSchedulerOutputState;
};

type AudioSchedulerBufferingTransition = {
	type: 'entered' | 'exited' | 'changed';
	source: 'provider' | 'scheduler';
	trigger: string;
	sequence: number;
	wallTimeMs: number;
	elapsedSincePreviousTransitionMs: number | null;
	providerBuffering: boolean;
	schedulerBuffering: boolean;
	bufferingActive: boolean;
	previousProviderBuffering: boolean;
	previousSchedulerBuffering: boolean;
	previousBufferingActive: boolean;
	providerActiveDurationMs: number | null;
	schedulerActiveDurationMs: number | null;
	combinedActiveDurationMs: number | null;
	frame: number;
	isPlaying: boolean;
	audioTime: number;
	currentAudioGlobalTime: number;
	currentVideoGlobalTime: number;
	audioVideoDriftSeconds: number;
	reason: string | null;
	affectedFeedIds: string[];
	minimumAheadSeconds: number | null;
	audioContextState: string;
	schedulerGateOpen: boolean;
	outputBefore: AudioSchedulerOutputState | null;
	outputAfter: AudioSchedulerOutputState;
	health: AudioFeedBufferHealth[];
};

type AudioSchedulerAudioContextTransition = {
	wallTimeMs: number;
	nativeState: string;
	remotionState: string | null;
	audioContextTime: number;
	providerBuffering: boolean;
	schedulerBuffering: boolean;
	schedulerGateOpen: boolean;
	masterGain: number | null;
	queuedNodeCount: number;
};

type AudioSchedulerAnchorEvent = {
	frame: number;
	audioTime: number;
	globalCompositionTime: number;
	audioGlobalCompositionTime: number;
	expectedAudioLeadSeconds: number;
	audioVideoDriftSeconds: number;
	previousAnchor: number;
	nextAnchor: number;
	shift: number;
	audioClockMinusTimeline: number;
};

type AudioSchedulerFrameTiming = {
	lastFrameDelta: number | null;
	lastCommitIntervalMs: number | null;
	lastEventLoopLagMs: number | null;
	maxEventLoopLagMs: number;
};

type AudioSchedulerFrameStall = {
	wallTimeMs: number;
	frame: number;
	previousFrame: number;
	frameDelta: number;
	expectedFrameDelta: number;
	commitIntervalMs: number;
	expectedCommitIntervalMs: number;
	eventLoopLagMs: number;
	reason: string;
	currentVideoGlobalTime: number;
	audioTime: number;
	currentAudioGlobalTime: number;
	audioVideoDriftSeconds: number;
	audioContextState: string;
	providerBuffering: boolean;
	schedulerBuffering: boolean;
	bufferingActive: boolean;
	schedulerGateOpen: boolean;
	bufferingReason: string | null;
};

type AudioSchedulerRuntime = {
	version: string;
	config: AudioFeedSchedulerConfig;
	frame: number;
	audioContext: {
		state: string;
		time: number;
		baseLatency: number;
		outputLatency: number;
		masterGain: number | null;
		anchor: number;
		globalCompositionTime: number;
		audioGlobalCompositionTime: number;
		expectedAudioLeadSeconds: number;
		audioVideoDriftSeconds: number;
		audioClockMinusTimeline: number;
	};
	queue: ReturnType<typeof getAudioSchedulerQueueDiagnostics>;
	frameTiming: AudioSchedulerFrameTiming;
	feeds: AudioSchedulerFeedRuntime[];
	buffering: AudioSchedulerBufferingStatus;
	bufferHealth: AudioFeedBufferHealth[];
	anchorChanges: number;
};

const makeInactiveBufferingStatus = (): AudioSchedulerBufferingStatus => ({
	active: false,
	reason: null,
	affectedFeedIds: [],
	minimumAheadSeconds: null,
	bufferingPositionGlobalTime: null,
	bufferingTargetGlobalTime: null,
	currentAudioGlobalTime: null,
	currentVideoGlobalTime: null,
	audioVideoDriftSeconds: null,
	startupReady: false,
	schedulerGateOpen: false,
});

/**
 * Preview implementation for grouped feed plans.
 *
 * A plan owns one MediaPlayer for its entire source recording. The timeline
 * mapper inside that player skips source gaps, and this component owns one
 * gain envelope containing all range-level volume and fade changes.
 */
export const AudioFeedSchedulerPreview: React.FC<{
	readonly plans: readonly NormalizedAudioFeedPlan[];
	readonly config?: AudioFeedSchedulerConfigOverrides;
}> = ({plans, config}) => {
	const sharedAudioContext = useContext(SharedAudioContext);
	const {isBuffering, isPlaying, subscribeBuffering, subscribePlaying} =
		useContext(SetTimelineContext);
	const buffer = useBufferState();
	const {fps} = useVideoConfig();
	const frame = useCurrentFrame();
	const logLevel = Internals.useLogLevel();
	const schedulerConfig = useMemo(
		() => resolveAudioFeedSchedulerConfig(config),
		[config],
	);
	const bufferingDecodeAheadSeconds = Math.max(
		schedulerConfig.decodeAheadSeconds,
		schedulerConfig.bufferingDecodeAheadSeconds,
		schedulerConfig.recoveryBufferSeconds +
			schedulerConfig.audioVideoDriftToleranceSeconds +
			AUDIO_SCHEDULER_BUFFERING_SAFETY_SECONDS,
	);
	const frameRef = useRef(frame);
	frameRef.current = frame;

	const parentSequence = useContext(SequenceContext);
	const schedulerStartTimeInSeconds = (parentSequence?.absoluteFrom ?? 0) / fps;
	// The grouped scheduler is rendered inside the segment's outer Sequence,
	// rather than inside each individual feed range. Keep the lifecycle flags in
	// refs so the scheduler can continue pre-decoding during premounting without
	// acquiring the shared playback buffer until the parent sequence is active.
	const parentIsPremounting = Boolean(parentSequence?.premounting);
	const parentIsPostmounting = Boolean(parentSequence?.postmounting);
	const parentIsPremountingRef = useRef(parentIsPremounting);
	const parentIsPostmountingRef = useRef(parentIsPostmounting);
	parentIsPremountingRef.current = parentIsPremounting;
	parentIsPostmountingRef.current = parentIsPostmounting;

	const slotsRef = useRef<Map<string, PlayerSlot>>(new Map());
	const controllerRef = useRef<AudioSchedulerController | null>(null);
	const lastDiagnosticsAudioTimeRef = useRef(-Infinity);
	const runtimeHistoryRef = useRef<AudioSchedulerRuntime[]>([]);
	const bufferingStatusRef = useRef<AudioSchedulerBufferingStatus>(
		makeInactiveBufferingStatus(),
	);
	const bufferHealthRef = useRef<AudioFeedBufferHealth[]>([]);
	const bufferingEventsRef = useRef<AudioSchedulerBufferingEvent[]>([]);
	const bufferingTransitionsRef = useRef<AudioSchedulerBufferingTransition[]>(
		[],
	);
	const bufferingWatchdogEventsRef = useRef<AudioSchedulerBufferingWatchdog[]>(
		[],
	);
	const audioContextTransitionsRef = useRef<
		AudioSchedulerAudioContextTransition[]
	>([]);
	const frameStallsRef = useRef<AudioSchedulerFrameStall[]>([]);
	const schedulerBufferingOwnerRef = useRef(false);
	const schedulerGateOpenRef = useRef(false);
	const latestOutputStateRef = useRef<AudioSchedulerOutputState | null>(null);
	const anchorChangesRef = useRef(0);
	const anchorEventsRef = useRef<AudioSchedulerAnchorEvent[]>([]);
	const lastObservedAnchorRef = useRef<number | null>(null);
	const previousFrameTimingRef = useRef<{
		frame: number;
		wallTimeMs: number;
	} | null>(null);
	const frameTimingRef = useRef<AudioSchedulerFrameTiming>({
		lastFrameDelta: null,
		lastCommitIntervalMs: null,
		lastEventLoopLagMs: null,
		maxEventLoopLagMs: 0,
	});

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
				config: schedulerConfig,
				capturedAt: new Date().toISOString(),
				sampleCount: runtimeHistoryRef.current.length,
				anchorEvents: anchorEventsRef.current,
				bufferingEvents: bufferingEventsRef.current,
				bufferingTransitions: bufferingTransitionsRef.current,
				bufferingWatchdog: bufferingWatchdogEventsRef.current,
				audioContextTransitions: audioContextTransitionsRef.current,
				frameStalls: frameStallsRef.current,
				bufferingDiagnostics: buffer.getBufferingDiagnostics?.() ?? null,
				liveOutputState: latestOutputStateRef.current,
				samples: runtimeHistoryRef.current,
			};

			// eslint-disable-next-line no-console
			console.info(
				'[AudioScheduler] collected feed runtime dump',
				JSON.stringify(dump),
			);
		};

		window.addEventListener('keydown', handleDiagnosticKeyDown);
		return () => {
			window.removeEventListener('keydown', handleDiagnosticKeyDown);
		};
	}, [buffer, schedulerConfig]);

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
		if (!sharedAudioContext?.audioContext || !sharedAudioContext.gainNode) {
			return;
		}

		runtimeHistoryRef.current = [];
		lastDiagnosticsAudioTimeRef.current = -Infinity;
		bufferingStatusRef.current = makeInactiveBufferingStatus();
		bufferHealthRef.current = [];
		bufferingEventsRef.current = [];
		bufferingTransitionsRef.current = [];
		bufferingWatchdogEventsRef.current = [];
		audioContextTransitionsRef.current = [];
		frameStallsRef.current = [];
		schedulerBufferingOwnerRef.current = false;
		schedulerGateOpenRef.current = false;
		latestOutputStateRef.current = null;
		anchorChangesRef.current = 0;
		anchorEventsRef.current = [];
		lastObservedAnchorRef.current = null;
		previousFrameTimingRef.current = null;
		frameTimingRef.current = {
			lastFrameDelta: null,
			lastCommitIntervalMs: null,
			lastEventLoopLagMs: null,
			maxEventLoopLagMs: 0,
		};

		const {
			audioContext,
			gainNode: masterGainNode,
			audioSyncAnchor,
			scheduleAudioNode,
			unscheduleAudioNode,
		} = sharedAudioContext;
		lastObservedAnchorRef.current = audioSyncAnchor.value;
		const slots = new Map<string, PlayerSlot>();
		const retiredSlots = new Map<PlayerSlot, number>();
		const isDisposed = {value: false};
		const bufferingOwner = {value: false};
		const bufferingHandle = {
			value: null as ReturnType<typeof buffer.delayPlayback> | null,
		};
		const bufferingLowWaterSince = {value: null as number | null};
		const bufferingRecoverySince = {value: null as number | null};
		// Buffering is a transport pause. Once we enter it, the presentation frame
		// and the native audio clock may stop advancing, so recovery must be measured
		// from the position at which we paused rather than from a moving clock.
		const bufferingPositionGlobalTime = {value: null as number | null};
		const bufferingTargetGlobalTime = {value: null as number | null};
		const startupReadySince = {value: null as number | null};
		const startupReady = {value: false};
		const lastBufferingWatchdogWallTime = {value: -Infinity};
		const initialProviderBuffering = isBuffering();
		const lastObservedProviderBuffering = {value: initialProviderBuffering};
		const lastObservedSchedulerBuffering = {value: false};
		const lastObservedCombinedBuffering = {value: initialProviderBuffering};
		const providerBufferingSince = {
			value: initialProviderBuffering ? performance.now() : null,
		};
		const schedulerBufferingSince = {value: null as number | null};
		const combinedBufferingSince = {
			value: initialProviderBuffering ? performance.now() : null,
		};
		const lastBufferingTransitionWallTime = {value: null as number | null};
		const bufferingTransitionSequence = {value: 0};
		const schedulerGateGainNode = audioContext.createGain();
		schedulerGateGainNode.gain.value = 0;
		schedulerGateGainNode.connect(masterGainNode);
		const schedulerGateOpen = {value: false};
		const setSchedulerGate = (open: boolean) => {
			if (schedulerGateOpen.value === open) {
				return;
			}

			const now = audioContext.currentTime;
			schedulerGateGainNode.gain.cancelScheduledValues(now);
			schedulerGateGainNode.gain.setValueAtTime(open ? 1 : 0, now);
			schedulerGateOpen.value = open;
			schedulerGateOpenRef.current = open;
		};
		const getCurrentVideoGlobalTime = () =>
			schedulerStartTimeInSeconds + frameRef.current / fps;
		const getExpectedAudioLeadSeconds = () =>
			audioContext.baseLatency + audioContext.outputLatency;
		const getAudioVideoClockState = (currentVideoGlobalTime: number) => {
			const audioTime = audioContext.currentTime;
			const currentAudioGlobalTime = audioTime - audioSyncAnchor.value;
			const expectedAudioLeadSeconds = getExpectedAudioLeadSeconds();
			return {
				audioTime,
				currentAudioGlobalTime,
				expectedAudioLeadSeconds,
				audioVideoDriftSeconds:
					currentAudioGlobalTime -
					currentVideoGlobalTime -
					expectedAudioLeadSeconds,
			};
		};
		const getOutputState = (): AudioSchedulerOutputState => {
			const feedGains = Array.from(slots.values()).map(
				(slot) => slot.gainNode.gain.value,
			);
			const outputState: AudioSchedulerOutputState = {
				audioContextState: audioContext.state,
				remotionAudioContextState: sharedAudioContext.getAudioContextState(),
				audioContextTime: audioContext.currentTime,
				audioSyncAnchor: audioSyncAnchor.value,
				masterGain: masterGainNode.gain.value,
				schedulerGateGain: schedulerGateGainNode.gain.value,
				providerBuffering: isBuffering(),
				bufferingOwner: bufferingOwner.value,
				bufferingHandleAcquired: bufferingHandle.value !== null,
				queuedNodeCount: Array.from(slots.values()).reduce(
					(total, slot) =>
						total +
						(slot.player.audioIteratorManager
							?.getAudioBufferIterator()
							?.getQueuedAudioNodeCount() ?? 0),
					0,
				),
				minimumFeedGain: feedGains.length > 0 ? Math.min(...feedGains) : null,
				maximumFeedGain: feedGains.length > 0 ? Math.max(...feedGains) : null,
			};
			latestOutputStateRef.current = outputState;
			return outputState;
		};
		const recordBufferingTransition = ({
			source,
			trigger,
			providerBuffering = isBuffering(),
			reason = bufferingStatusRef.current.reason,
			outputBefore = null,
		}: {
			source: 'provider' | 'scheduler';
			trigger: string;
			providerBuffering?: boolean;
			reason?: string | null;
			outputBefore?: AudioSchedulerOutputState | null;
		}) => {
			const wallTimeMs = performance.now();
			const schedulerBuffering = bufferingOwner.value;
			const previousProviderBuffering = lastObservedProviderBuffering.value;
			const previousSchedulerBuffering = lastObservedSchedulerBuffering.value;
			const previousBufferingActive = lastObservedCombinedBuffering.value;

			// The provider subscription and scheduler state changes can happen in
			// different turns. Record either dimension independently, including cases
			// where one lease is released while the other one is still active.
			if (
				providerBuffering === previousProviderBuffering &&
				schedulerBuffering === previousSchedulerBuffering
			) {
				return;
			}

			const bufferingActive = providerBuffering || schedulerBuffering;
			const currentVideoGlobalTime = getCurrentVideoGlobalTime();
			const clock = getAudioVideoClockState(currentVideoGlobalTime);
			const outputAfter = getOutputState();
			const providerActiveDurationMs =
				!providerBuffering &&
				previousProviderBuffering &&
				providerBufferingSince.value !== null
					? wallTimeMs - providerBufferingSince.value
					: null;
			const schedulerActiveDurationMs =
				!schedulerBuffering &&
				previousSchedulerBuffering &&
				schedulerBufferingSince.value !== null
					? wallTimeMs - schedulerBufferingSince.value
					: null;
			const combinedActiveDurationMs =
				!bufferingActive &&
				previousBufferingActive &&
				combinedBufferingSince.value !== null
					? wallTimeMs - combinedBufferingSince.value
					: null;
			const transition: AudioSchedulerBufferingTransition = {
				type:
					!previousBufferingActive && bufferingActive
						? 'entered'
						: previousBufferingActive && !bufferingActive
							? 'exited'
							: 'changed',
				source,
				trigger,
				sequence: bufferingTransitionSequence.value++,
				wallTimeMs,
				elapsedSincePreviousTransitionMs:
					lastBufferingTransitionWallTime.value === null
						? null
						: wallTimeMs - lastBufferingTransitionWallTime.value,
				providerBuffering,
				schedulerBuffering,
				bufferingActive,
				previousProviderBuffering,
				previousSchedulerBuffering,
				previousBufferingActive,
				providerActiveDurationMs,
				schedulerActiveDurationMs,
				combinedActiveDurationMs,
				frame: frameRef.current,
				isPlaying: isPlaying(),
				audioTime: clock.audioTime,
				currentAudioGlobalTime: clock.currentAudioGlobalTime,
				currentVideoGlobalTime,
				audioVideoDriftSeconds: clock.audioVideoDriftSeconds,
				reason,
				affectedFeedIds: [...bufferingStatusRef.current.affectedFeedIds],
				minimumAheadSeconds: bufferingStatusRef.current.minimumAheadSeconds,
				audioContextState: outputAfter.audioContextState,
				schedulerGateOpen: schedulerGateOpen.value,
				outputBefore,
				outputAfter,
				health: bufferHealthRef.current.map((feed) => ({...feed})),
			};

			bufferingTransitionsRef.current.push(transition);
			if (
				bufferingTransitionsRef.current.length >
				AUDIO_SCHEDULER_BUFFERING_TRANSITION_HISTORY_LIMIT
			) {
				bufferingTransitionsRef.current.splice(
					0,
					bufferingTransitionsRef.current.length -
						AUDIO_SCHEDULER_BUFFERING_TRANSITION_HISTORY_LIMIT,
				);
			}

			if (providerBuffering && !previousProviderBuffering) {
				providerBufferingSince.value = wallTimeMs;
			} else if (!providerBuffering && previousProviderBuffering) {
				providerBufferingSince.value = null;
			}
			if (schedulerBuffering && !previousSchedulerBuffering) {
				schedulerBufferingSince.value = wallTimeMs;
			} else if (!schedulerBuffering && previousSchedulerBuffering) {
				schedulerBufferingSince.value = null;
			}
			if (bufferingActive && !previousBufferingActive) {
				combinedBufferingSince.value = wallTimeMs;
			} else if (!bufferingActive && previousBufferingActive) {
				combinedBufferingSince.value = null;
			}
			lastObservedProviderBuffering.value = providerBuffering;
			lastObservedSchedulerBuffering.value = schedulerBuffering;
			lastObservedCombinedBuffering.value = bufferingActive;
			lastBufferingTransitionWallTime.value = wallTimeMs;

		};
		const handleAudioContextStateChange = () => {
			const output = getOutputState();
			const transition: AudioSchedulerAudioContextTransition = {
				wallTimeMs: performance.now(),
				nativeState: output.audioContextState,
				remotionState: output.remotionAudioContextState,
				audioContextTime: output.audioContextTime,
				providerBuffering: output.providerBuffering,
				schedulerBuffering: bufferingOwner.value,
				schedulerGateOpen: schedulerGateOpen.value,
				masterGain: output.masterGain,
				queuedNodeCount: output.queuedNodeCount,
			};
			audioContextTransitionsRef.current.push(transition);
			if (
				audioContextTransitionsRef.current.length >
				AUDIO_SCHEDULER_AUDIO_CONTEXT_HISTORY_LIMIT
			) {
				audioContextTransitionsRef.current.splice(
					0,
					audioContextTransitionsRef.current.length -
						AUDIO_SCHEDULER_AUDIO_CONTEXT_HISTORY_LIMIT,
				);
			}
		};
		audioContext.addEventListener('statechange', handleAudioContextStateChange);
		const acquireBufferingHandle = () => {
			if (!bufferingHandle.value) {
				bufferingHandle.value = buffer.delayPlayback({
					label: 'audio-scheduler',
					source: 'AudioFeedSchedulerPreview',
					mediaType: 'audio',
					reason: 'scheduler-buffering',
				});
			}
		};
		const releaseBufferingHandle = () => {
			bufferingHandle.value?.unblock('scheduler-buffering-released');
			bufferingHandle.value = null;
		};
		slotsRef.current = slots;

		const recordBufferingEvent = ({
			type,
			audioTime,
			currentAudioGlobalTime,
			currentVideoGlobalTime,
			audioVideoDriftSeconds,
			reason,
			affectedFeedIds,
			minimumAheadSeconds,
			health,
			outputBefore,
		}: Omit<AudioSchedulerBufferingEvent, 'wallTimeMs' | 'outputAfter'>) => {
			const outputAfter = getOutputState();
			bufferingEventsRef.current.push({
				type,
				wallTimeMs: performance.now(),
				audioTime,
				currentAudioGlobalTime,
				currentVideoGlobalTime,
				audioVideoDriftSeconds,
				reason,
				affectedFeedIds: [...affectedFeedIds],
				minimumAheadSeconds,
				health: health.map((feed) => ({...feed})),
				outputBefore,
				outputAfter,
			});
			if (bufferingEventsRef.current.length > 64) {
				bufferingEventsRef.current.splice(
					0,
					bufferingEventsRef.current.length - 64,
				);
			}
		};

		const getQueuedCompositionPeriod = (
			slot: PlayerSlot,
			queuedPeriod: {from: number; until: number},
		) => {
			const queuedCompositionFrom =
				slot.timeline.getCompositionTimeForSourceTime(queuedPeriod.from);
			const endProbe = Math.max(
				queuedPeriod.from,
				queuedPeriod.until - AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS,
			);
			const mappedCompositionUntil =
				slot.timeline.getCompositionTimeForSourceTime(endProbe);
			const queuedCompositionUntil =
				mappedCompositionUntil === null
					? slot.plan.durationInSeconds
					: Math.min(
							slot.plan.durationInSeconds,
							mappedCompositionUntil +
								AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS,
						);

			return {queuedCompositionFrom, queuedCompositionUntil};
		};

		const getBufferHealth = (
			currentGlobalTime: number,
			currentAudioGlobalTime: number,
			recoveryTargetGlobalTime: number,
		): AudioFeedBufferHealth[] => {
			// Startup and recovery are horizon checks, not checks against the next
			// individual chunk. During scheduler-owned buffering the recovery horizon
			// stays anchored to the frozen pause position; otherwise it rolls with the
			// current presentation position.
			const startupTargetGlobalTime =
				currentGlobalTime + schedulerConfig.startupBufferSeconds;

			return plans.map((plan) => {
				const slot = slots.get(plan.trackId);
				const currentLocalTime = getPlayerLocalTime({
					globalCompositionTime: currentGlobalTime,
					plan,
					schedulerStartTimeInSeconds,
					fps,
				});
				const nextRange = plan.ranges.find((range) => {
					const rangeEnd = range.startTimeInSeconds + range.durationInSeconds;
					return (
						rangeEnd >
						currentLocalTime + AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS
					);
				});

				if (!nextRange) {
					return {
						trackId: plan.trackId,
						currentLocalTime,
						nextAudioStartTime: null,
						timeToNextAudio: null,
						queuedCompositionFrom: null,
						queuedCompositionUntil: null,
						compositionAhead: null,
						requiredForPlayback: false,
						requiredForStartup: false,
						requiredForRecovery: false,
						healthyForStartup: true,
						atRisk: false,
						healthyForRecovery: true,
						reason: 'feed-ended',
					};
				}

				const nextRangeEnd =
					nextRange.startTimeInSeconds + nextRange.durationInSeconds;
				const isAudibleNow =
					currentLocalTime + AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS >=
						nextRange.startTimeInSeconds &&
					currentLocalTime <
						nextRangeEnd - AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS;
				const timeToNextAudio = Math.max(
					0,
					nextRange.startTimeInSeconds - currentLocalTime,
				);
				const startupTargetLocalTime = getPlayerLocalTime({
					globalCompositionTime: startupTargetGlobalTime,
					plan,
					schedulerStartTimeInSeconds,
					fps,
				});
				const recoveryTargetLocalTime = getPlayerLocalTime({
					globalCompositionTime: recoveryTargetGlobalTime,
					plan,
					schedulerStartTimeInSeconds,
					fps,
				});
				const targetRequiresAudioThrough = (targetLocalTime: number) =>
					targetLocalTime >
					nextRange.startTimeInSeconds +
						AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS;
				const requiredForPlayback =
					isAudibleNow ||
					timeToNextAudio <= schedulerConfig.lowWatermarkSeconds;
				// Future ranges are deliberately decoded in the rolling window, but
				// they are not a reason to block the shared Remotion transport. This is
				// the same distinction Remotion makes for premounted media: initialize
				// it opportunistically, and only delay playback when the media is active
				// or close enough to the playhead to be required soon.
				const requiredForStartup =
					requiredForPlayback &&
					targetRequiresAudioThrough(startupTargetLocalTime);
				const requiredForRecovery =
					requiredForPlayback &&
					targetRequiresAudioThrough(recoveryTargetLocalTime);

				if (
					!requiredForPlayback &&
					!requiredForStartup &&
					!requiredForRecovery
				) {
					return {
						trackId: plan.trackId,
						currentLocalTime,
						nextAudioStartTime: nextRange.startTimeInSeconds,
						timeToNextAudio,
						queuedCompositionFrom: null,
						queuedCompositionUntil: null,
						compositionAhead: null,
						requiredForPlayback: false,
						requiredForStartup: false,
						requiredForRecovery: false,
						healthyForStartup: true,
						atRisk: false,
						healthyForRecovery: true,
						reason: 'planned-silence',
					};
				}

				if (!slot) {
					return {
						trackId: plan.trackId,
						currentLocalTime,
						nextAudioStartTime: nextRange.startTimeInSeconds,
						timeToNextAudio,
						queuedCompositionFrom: null,
						queuedCompositionUntil: null,
						compositionAhead: null,
						requiredForPlayback,
						requiredForStartup,
						requiredForRecovery,
						healthyForStartup: !requiredForStartup,
						atRisk: requiredForPlayback,
						healthyForRecovery: !requiredForRecovery,
						reason: 'player-not-mounted',
					};
				}

				const iteratorManager = slot.player.audioIteratorManager;
				const iterator = iteratorManager?.getAudioBufferIterator();
				const queuedPeriod = iterator?.getQueuedPeriod() ?? null;
				if (!iterator) {
					return {
						trackId: plan.trackId,
						currentLocalTime,
						nextAudioStartTime: nextRange.startTimeInSeconds,
						timeToNextAudio,
						queuedCompositionFrom: null,
						queuedCompositionUntil: null,
						compositionAhead: null,
						requiredForPlayback,
						requiredForStartup,
						requiredForRecovery,
						healthyForStartup: !requiredForStartup,
						atRisk: requiredForPlayback,
						healthyForRecovery: !requiredForRecovery,
						reason: 'iterator-not-ready',
					};
				}

				if (!queuedPeriod) {
					return {
						trackId: plan.trackId,
						currentLocalTime,
						nextAudioStartTime: nextRange.startTimeInSeconds,
						timeToNextAudio,
						queuedCompositionFrom: null,
						queuedCompositionUntil: null,
						compositionAhead: null,
						requiredForPlayback,
						requiredForStartup,
						requiredForRecovery,
						healthyForStartup: !requiredForStartup,
						atRisk: requiredForPlayback,
						healthyForRecovery: !requiredForRecovery,
						reason: 'no-queued-audio',
					};
				}

				const {queuedCompositionFrom, queuedCompositionUntil} =
					getQueuedCompositionPeriod(slot, queuedPeriod);
				const requiredCompositionTime = Math.max(
					currentLocalTime,
					nextRange.startTimeInSeconds,
				);
				const compositionAhead =
					queuedCompositionUntil - requiredCompositionTime;
				// A node that has already ended in the AudioContext can disappear from
				// queuedPeriod while its samples are still in the output pipeline. When
				// the video frame is still at zero, this otherwise looks like the
				// remaining queue starts after the playhead even though the transport has
				// already consumed that prefix. Only treat it as a real gap when the
				// queue starts after both transport clocks.
				const currentAudioLocalTime =
					currentAudioGlobalTime - schedulerStartTimeInSeconds;
				const queueStartReferenceTime = Math.max(
					requiredCompositionTime,
					currentAudioLocalTime,
				);
				const queueStartsAfterPlayhead =
					queuedCompositionFrom !== null &&
					queuedCompositionFrom >
						queueStartReferenceTime + AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS;
				// A finite feed cannot provide the normal recovery watermark after its
				// natural end. Reaching the end of the normalized composition is therefore
				// a successful terminal state, even when less than the configured
				// low-water/recovery duration remains.
				const queueCoversPlanEnd =
					queuedCompositionUntil >=
					plan.durationInSeconds - AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS;
				const queueCoversTarget = (targetLocalTime: number) =>
					!queueStartsAfterPlayhead &&
					(queueCoversPlanEnd ||
						queuedCompositionUntil >=
							targetLocalTime - AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS);
				const atRisk =
					requiredForPlayback &&
					!queueCoversPlanEnd &&
					(queueStartsAfterPlayhead ||
						compositionAhead < schedulerConfig.lowWatermarkSeconds);
				const healthyForStartup =
					!requiredForStartup || queueCoversTarget(startupTargetLocalTime);
				const healthyForRecovery =
					!requiredForRecovery || queueCoversTarget(recoveryTargetLocalTime);

				return {
					trackId: plan.trackId,
					currentLocalTime,
					nextAudioStartTime: nextRange.startTimeInSeconds,
					timeToNextAudio,
					queuedCompositionFrom,
					queuedCompositionUntil,
					compositionAhead,
					requiredForPlayback,
					requiredForStartup,
					requiredForRecovery,
					healthyForStartup,
					atRisk,
					healthyForRecovery,
					reason: queueStartsAfterPlayhead
						? 'queue-start-after-playhead'
						: queueCoversPlanEnd
							? 'queued-to-feed-end'
							: !healthyForRecovery
								? 'recovery-coverage-low'
								: !healthyForStartup
									? 'startup-coverage-low'
									: compositionAhead < schedulerConfig.lowWatermarkSeconds
										? 'low-composition-coverage'
										: 'queued',
				};
			});
		};

		const getMinimumAheadSeconds = (
			health: readonly AudioFeedBufferHealth[],
		) => {
			const aheadValues = health
				.filter((feed) => feed.requiredForRecovery)
				.map((feed) => feed.compositionAhead ?? 0);
			return aheadValues.length > 0 ? Math.min(...aheadValues) : null;
		};
		const enterSchedulerBuffering = ({
			reason,
			health,
			currentVideoGlobalTime,
			currentAudioGlobalTime,
			audioVideoDriftSeconds,
			minimumAheadSeconds,
		}: {
			reason: string;
			health: readonly AudioFeedBufferHealth[];
			currentVideoGlobalTime: number;
			currentAudioGlobalTime: number;
			audioVideoDriftSeconds: number;
			minimumAheadSeconds: number | null;
		}) => {
			if (bufferingOwner.value) {
				return;
			}

			const recoveryAheadSeconds = Math.max(
				schedulerConfig.startupBufferSeconds,
				schedulerConfig.recoveryBufferSeconds,
			);
			bufferingPositionGlobalTime.value = currentVideoGlobalTime;
			bufferingTargetGlobalTime.value =
				currentVideoGlobalTime + recoveryAheadSeconds;
			const outputBefore = getOutputState();
			bufferingOwner.value = true;
			schedulerBufferingOwnerRef.current = true;
			setSchedulerGate(false);
			acquireBufferingHandle();

			bufferingStatusRef.current = {
				active: true,
				reason,
				affectedFeedIds: health
					.filter(
						(feed) =>
							feed.atRisk ||
							!feed.healthyForStartup ||
							!feed.healthyForRecovery,
					)
					.map((feed) => feed.trackId),
				minimumAheadSeconds,
				bufferingPositionGlobalTime: bufferingPositionGlobalTime.value,
				bufferingTargetGlobalTime: bufferingTargetGlobalTime.value,
				currentAudioGlobalTime,
				currentVideoGlobalTime,
				audioVideoDriftSeconds,
				startupReady: startupReady.value,
				schedulerGateOpen: schedulerGateOpen.value,
			};
			recordBufferingEvent({
				type: 'entered',
				audioTime: audioContext.currentTime,
				currentAudioGlobalTime,
				currentVideoGlobalTime,
				audioVideoDriftSeconds,
				reason,
				affectedFeedIds: bufferingStatusRef.current.affectedFeedIds,
				minimumAheadSeconds,
				health: [...health],
				outputBefore,
			});
			recordBufferingTransition({
				source: 'scheduler',
				trigger: `scheduler-enter:${reason}`,
				reason,
				outputBefore,
			});
		};
		const recoverSchedulerBuffering = ({
			reason,
			health,
			currentVideoGlobalTime,
			currentAudioGlobalTime,
			audioVideoDriftSeconds,
			minimumAheadSeconds,
		}: {
			reason: string;
			health: readonly AudioFeedBufferHealth[];
			currentVideoGlobalTime: number;
			currentAudioGlobalTime: number;
			audioVideoDriftSeconds: number;
			minimumAheadSeconds: number | null;
		}) => {
			if (!bufferingOwner.value) {
				return;
			}

			const outputBefore = getOutputState();
			bufferingOwner.value = false;
			schedulerBufferingOwnerRef.current = false;
			releaseBufferingHandle();
			bufferingPositionGlobalTime.value = null;
			bufferingTargetGlobalTime.value = null;
			bufferingLowWaterSince.value = null;
			bufferingRecoverySince.value = null;
			// BufferingProvider removes our lease in a layout effect. Keep the
			// audio gate closed until that shared state has actually cleared.
			setSchedulerGate(!isBuffering());
			bufferingStatusRef.current = {
				active: isBuffering(),
				reason: isBuffering() ? 'external-buffering' : null,
				affectedFeedIds: [],
				minimumAheadSeconds,
				bufferingPositionGlobalTime: null,
				bufferingTargetGlobalTime: null,
				currentAudioGlobalTime,
				currentVideoGlobalTime,
				audioVideoDriftSeconds,
				startupReady: startupReady.value,
				schedulerGateOpen: schedulerGateOpen.value,
			};
			recordBufferingEvent({
				type: 'recovered',
				audioTime: audioContext.currentTime,
				currentAudioGlobalTime,
				currentVideoGlobalTime,
				audioVideoDriftSeconds,
				reason,
				affectedFeedIds: [],
				minimumAheadSeconds,
				health: [...health],
				outputBefore,
			});
			recordBufferingTransition({
				source: 'scheduler',
				trigger: `scheduler-recover:${reason}`,
				reason,
				outputBefore,
			});
		};

		const evaluateBuffering = () => {
			if (isDisposed.value) {
				return;
			}

			// The frame loop is intentionally stopped by buffering. Keep waking the
			// queue from this wall-clock watchdog so pending decodes can finish while
			// playback is paused at the low-water mark.
			for (const slot of slots.values()) {
				if (!slot.disposed) {
					slot.player.wakeAudioScheduling();
				}
			}

			// Match Remotion's normal media behavior: premounted/postmounted media
			// may load and decode, but it must not hold the shared playback transport.
			// The scheduler has one global buffer lease, so explicitly release that
			// lease if a parent Sequence moves outside its active interval.
			const parentIsOutsideActiveSequence =
				parentIsPremountingRef.current || parentIsPostmountingRef.current;
			if (parentIsOutsideActiveSequence) {
				const currentVideoGlobalTime = getCurrentVideoGlobalTime();
				const clock = getAudioVideoClockState(currentVideoGlobalTime);
				const hadSchedulerBuffering = bufferingOwner.value;
				const outputBefore = hadSchedulerBuffering ? getOutputState() : null;
				const lifecycleReason = parentIsPremountingRef.current
					? 'parent-premounting'
					: 'parent-postmounting';

				if (bufferingOwner.value) {
					bufferingOwner.value = false;
					schedulerBufferingOwnerRef.current = false;
					releaseBufferingHandle();
				}
				bufferingPositionGlobalTime.value = null;
				bufferingTargetGlobalTime.value = null;
				bufferingLowWaterSince.value = null;
				bufferingRecoverySince.value = null;
				startupReadySince.value = null;
				startupReady.value = false;
				setSchedulerGate(false);
				bufferHealthRef.current = [];
				bufferingStatusRef.current = {
					...makeInactiveBufferingStatus(),
					active: isBuffering(),
					reason: isBuffering() ? 'external-buffering' : lifecycleReason,
					currentAudioGlobalTime: clock.currentAudioGlobalTime,
					currentVideoGlobalTime,
					audioVideoDriftSeconds: clock.audioVideoDriftSeconds,
				};

				if (hadSchedulerBuffering) {
					recordBufferingEvent({
						type: 'cancelled',
						audioTime: clock.audioTime,
						currentAudioGlobalTime: clock.currentAudioGlobalTime,
						currentVideoGlobalTime,
						audioVideoDriftSeconds: clock.audioVideoDriftSeconds,
						reason: lifecycleReason,
						affectedFeedIds: [],
						minimumAheadSeconds: null,
						health: [],
						outputBefore,
					});
					recordBufferingTransition({
						source: 'scheduler',
						trigger: `scheduler-cancel:${lifecycleReason}`,
						reason: lifecycleReason,
						outputBefore,
					});
				}

				return;
			}

			if (!isPlaying()) {
				bufferingLowWaterSince.value = null;
				bufferingRecoverySince.value = null;
				startupReadySince.value = null;
				startupReady.value = false;
				setSchedulerGate(false);
				if (bufferingOwner.value) {
					const previousStatus = bufferingStatusRef.current;
					const outputBefore = getOutputState();
					bufferingOwner.value = false;
					schedulerBufferingOwnerRef.current = false;
					releaseBufferingHandle();
					bufferingPositionGlobalTime.value = null;
					bufferingTargetGlobalTime.value = null;
					recordBufferingEvent({
						type: 'cancelled',
						audioTime: audioContext.currentTime,
						currentAudioGlobalTime: previousStatus.currentAudioGlobalTime,
						currentVideoGlobalTime: previousStatus.currentVideoGlobalTime,
						audioVideoDriftSeconds: previousStatus.audioVideoDriftSeconds,
						reason: 'playback-stopped',
						affectedFeedIds: previousStatus.affectedFeedIds,
						minimumAheadSeconds: previousStatus.minimumAheadSeconds,
						health: bufferHealthRef.current.map((feed) => ({...feed})),
						outputBefore,
					});
				}

				if (isBuffering()) {
					const currentVideoGlobalTime = getCurrentVideoGlobalTime();
					const clock = getAudioVideoClockState(currentVideoGlobalTime);
					bufferingStatusRef.current = {
						...makeInactiveBufferingStatus(),
						active: true,
						reason: 'external-buffering',
						currentAudioGlobalTime: clock.currentAudioGlobalTime,
						currentVideoGlobalTime,
						audioVideoDriftSeconds: clock.audioVideoDriftSeconds,
					};
				} else {
					bufferingStatusRef.current = makeInactiveBufferingStatus();
				}
				recordBufferingTransition({
					source: 'scheduler',
					trigger: 'scheduler-cancel:playback-stopped',
					reason: 'playback-stopped',
				});
				return;
			}

			const currentVideoGlobalTime = getCurrentVideoGlobalTime();
			const clock = getAudioVideoClockState(currentVideoGlobalTime);
			const {currentAudioGlobalTime, audioVideoDriftSeconds} = clock;
			const healthEvaluationGlobalTime =
				bufferingOwner.value && bufferingPositionGlobalTime.value !== null
					? bufferingPositionGlobalTime.value
					: currentVideoGlobalTime;
			const recoveryTargetGlobalTime =
				bufferingOwner.value && bufferingTargetGlobalTime.value !== null
					? bufferingTargetGlobalTime.value
					: currentVideoGlobalTime + schedulerConfig.recoveryBufferSeconds;
			const health = getBufferHealth(
				healthEvaluationGlobalTime,
				currentAudioGlobalTime,
				recoveryTargetGlobalTime,
			);
			bufferHealthRef.current = health;
			const atRisk = health.filter((feed) => feed.atRisk);
			const allFeedsReadyForStartup = health.every(
				(feed) => feed.healthyForStartup,
			);
			const allFeedsRecovered = health.every((feed) => feed.healthyForRecovery);
			const minimumAheadSeconds = getMinimumAheadSeconds(health);
			const wallTimeMs = performance.now();

			// The normal frame loop stops while buffering. Capture the state of the
			// refill path from this wall-clock watchdog once per second so a diagnostic
			// dump can distinguish "decoder is refilling" from "scheduler is stuck".
			// In particular, liveOutputState alone can be stale if no native state
			// transition occurs after buffering starts.
			if (bufferingOwner.value) {
				const output = getOutputState();
				if (wallTimeMs - lastBufferingWatchdogWallTime.value >= 1000) {
					lastBufferingWatchdogWallTime.value = wallTimeMs;
					const healthByTrackId = new Map(
						health.map((feed) => [feed.trackId, feed]),
					);
					const reasonCounts: Record<string, number> = {};
					for (const feed of health) {
						reasonCounts[feed.reason] = (reasonCounts[feed.reason] ?? 0) + 1;
					}

					const watchdog: AudioSchedulerBufferingWatchdog = {
						wallTimeMs,
						reason: bufferingStatusRef.current.reason,
						isPlaying: isPlaying(),
						isBuffering: isBuffering(),
						currentAudioGlobalTime,
						currentVideoGlobalTime,
						audioVideoDriftSeconds,
						minimumAheadSeconds,
						allFeedsRecovered,
						queue: getAudioSchedulerQueueDiagnostics(),
						output,
						healthSummary: {
							recoveryReadyCount: health.filter(
								(feed) => feed.healthyForRecovery,
							).length,
							startupReadyCount: health.filter((feed) => feed.healthyForStartup)
								.length,
							atRiskCount: atRisk.length,
							reasonCounts,
						},
						feeds: plans.map((plan) => {
							const slot = slots.get(plan.trackId);
							const iteratorManager = slot?.player.audioIteratorManager;
							const iterator = iteratorManager?.getAudioBufferIterator();
							const queuedPeriod = iterator?.getQueuedPeriod() ?? null;
							const feedHealth = healthByTrackId.get(plan.trackId);
							return {
								trackId: plan.trackId,
								queuedNodeCount: iterator?.getQueuedAudioNodeCount() ?? 0,
								queuedCompositionFrom:
									feedHealth?.queuedCompositionFrom ?? null,
								queuedCompositionUntil:
									feedHealth?.queuedCompositionUntil ?? null,
								compositionAhead: feedHealth?.compositionAhead ?? null,
								reason: feedHealth?.reason ?? 'player-not-mounted',
								iteratorCount: iteratorManager?.getAudioIteratorsCreated() ?? 0,
								schedulingTurnsStarted:
									iteratorManager?.getAudioSchedulingTurnsStarted() ?? 0,
								schedulingTurnsCompleted:
									iteratorManager?.getAudioSchedulingTurnsCompleted() ?? 0,
								chunksScheduled:
									iteratorManager?.getAudioChunksScheduled() ?? 0,
								rejectedChunks: iteratorManager?.getAudioChunksRejected() ?? 0,
								lastRejectReason:
									iteratorManager?.getLastAudioChunkRejectionReason() ?? null,
								scheduledSeconds:
									iteratorManager?.getTotalAudioScheduledInSeconds() ?? 0,
								queuedSourceFrom: queuedPeriod?.from ?? null,
								queuedSourceUntil: queuedPeriod?.until ?? null,
							};
						}),
					};
					bufferingWatchdogEventsRef.current.push(watchdog);
					if (bufferingWatchdogEventsRef.current.length > 64) {
						bufferingWatchdogEventsRef.current.splice(
							0,
							bufferingWatchdogEventsRef.current.length - 64,
						);
					}
					// eslint-disable-next-line no-console
				}
			}
			const externalBuffering = isBuffering() && !bufferingOwner.value;
			if (isBuffering()) {
				// A visual media player owns this buffer lease. Close the scheduler
				// gate immediately, while usePlayback is the single owner of native
				// AudioContext suspend/resume for the shared provider state. Calling
				// suspendForBuffering here as well creates competing native requests
				// when several video elements cross a dense cut boundary together.
				setSchedulerGate(false);
			}

			// The output gate stays closed until every feed that is currently audible
			// (or inside the low-water window) has a real queue covering the configured
			// startup watermark. Future/premounted ranges are still decoded on a
			// best-effort basis, but their readiness cannot hold this shared buffer.
			if (!startupReady.value) {
				setSchedulerGate(false);
				bufferingLowWaterSince.value = null;
				bufferingRecoverySince.value = null;

				if (allFeedsReadyForStartup && !externalBuffering) {
					startupReadySince.value ??= wallTimeMs;
				} else {
					startupReadySince.value = null;
				}

				const startupHasBeenStable =
					startupReadySince.value !== null &&
					wallTimeMs - startupReadySince.value >=
						schedulerConfig.recoveryStableMs;

				if (startupHasBeenStable) {
					startupReady.value = true;
					startupReadySince.value = null;
					if (bufferingOwner.value) {
						recoverSchedulerBuffering({
							reason: 'startup-ready',
							health,
							currentVideoGlobalTime,
							currentAudioGlobalTime,
							audioVideoDriftSeconds,
							minimumAheadSeconds,
						});
					} else if (!isBuffering()) {
						setSchedulerGate(true);
					}

					bufferingStatusRef.current = {
						active: isBuffering(),
						reason: isBuffering() ? 'external-buffering' : null,
						affectedFeedIds: [],
						minimumAheadSeconds,
						bufferingPositionGlobalTime: bufferingPositionGlobalTime.value,
						bufferingTargetGlobalTime: bufferingTargetGlobalTime.value,
						currentAudioGlobalTime,
						currentVideoGlobalTime,
						audioVideoDriftSeconds,
						startupReady: true,
						schedulerGateOpen: schedulerGateOpen.value,
					};
					return;
				}

				if (!bufferingOwner.value && !isBuffering() && !startupHasBeenStable) {
					enterSchedulerBuffering({
						reason: 'startup-buffering',
						health,
						currentVideoGlobalTime,
						currentAudioGlobalTime,
						audioVideoDriftSeconds,
						minimumAheadSeconds,
					});
					return;
				}

				bufferingStatusRef.current = {
					active: bufferingOwner.value || isBuffering(),
					reason: bufferingOwner.value
						? 'startup-buffering'
						: 'external-buffering',
					affectedFeedIds: health
						.filter((feed) => !feed.healthyForStartup)
						.map((feed) => feed.trackId),
					minimumAheadSeconds,
					bufferingPositionGlobalTime: bufferingPositionGlobalTime.value,
					bufferingTargetGlobalTime: bufferingTargetGlobalTime.value,
					currentAudioGlobalTime,
					currentVideoGlobalTime,
					audioVideoDriftSeconds,
					startupReady: false,
					schedulerGateOpen: schedulerGateOpen.value,
				};
				return;
			}

			// Queue inspection and decoder completion happen on different turns. A
			// single low-water sample can therefore be transient while the queue is
			// being rebuilt, so require the condition to persist before pausing.
			if (atRisk.length > 0) {
				bufferingLowWaterSince.value ??= wallTimeMs;
			} else {
				bufferingLowWaterSince.value = null;
			}

			// Releasing buffering resumes the native context with the queued timestamps
			// intact. Require healthy coverage to remain stable before opening the gate
			// again; this prevents a stop/resume feedback loop at a dense cut boundary.
			if (bufferingOwner.value) {
				if (allFeedsRecovered) {
					bufferingRecoverySince.value ??= wallTimeMs;
				} else {
					bufferingRecoverySince.value = null;
				}
			} else {
				bufferingRecoverySince.value = null;
			}

			const lowWaterHasBeenStable =
				bufferingLowWaterSince.value !== null &&
				wallTimeMs - bufferingLowWaterSince.value >=
					schedulerConfig.lowWaterStableMs;

			if (
				atRisk.length > 0 &&
				!bufferingOwner.value &&
				!isBuffering() &&
				lowWaterHasBeenStable
			) {
				enterSchedulerBuffering({
					reason: atRisk[0]?.reason ?? 'low-composition-coverage',
					health,
					currentVideoGlobalTime,
					currentAudioGlobalTime,
					audioVideoDriftSeconds,
					minimumAheadSeconds,
				});
				return;
			}

			if (
				bufferingOwner.value &&
				allFeedsRecovered &&
				bufferingRecoverySince.value !== null &&
				wallTimeMs - bufferingRecoverySince.value >=
					schedulerConfig.recoveryStableMs
			) {
				recoverSchedulerBuffering({
					reason: 'coverage-recovered',
					health,
					currentVideoGlobalTime,
					currentAudioGlobalTime,
					audioVideoDriftSeconds,
					minimumAheadSeconds,
				});
				return;
			}

			if (!bufferingOwner.value && !isBuffering()) {
				setSchedulerGate(true);
			}

			bufferingStatusRef.current = {
				active: bufferingOwner.value || isBuffering(),
				reason: bufferingOwner.value
					? (atRisk[0]?.reason ?? 'waiting-for-recovery')
					: isBuffering()
						? 'external-buffering'
						: null,
				affectedFeedIds: atRisk.map((feed) => feed.trackId),
				minimumAheadSeconds,
				bufferingPositionGlobalTime: bufferingPositionGlobalTime.value,
				bufferingTargetGlobalTime: bufferingTargetGlobalTime.value,
				currentAudioGlobalTime,
				currentVideoGlobalTime,
				audioVideoDriftSeconds,
				startupReady: true,
				schedulerGateOpen: schedulerGateOpen.value,
			};
		};

		const disconnectRetiredSlots = () => {
			const now = audioContext.currentTime;
			for (const [slot, disconnectAt] of retiredSlots) {
				if (now < disconnectAt) {
					continue;
				}

				slot.gainNode.disconnect();
				retiredSlots.delete(slot);
			}
		};

		const disposeSlot = (slot: PlayerSlot, immediate = false) => {
			if (slot.disposed) {
				return;
			}

			slot.disposed = true;
			if (slots.get(slot.plan.trackId) === slot) {
				slots.delete(slot.plan.trackId);
			}

			const now = audioContext.currentTime;
			if (immediate) {
				slot.gainNode.gain.cancelScheduledValues(now);
				slot.gainNode.gain.setValueAtTime(0, now);
				slot.player.audioSyncAnchorChanged();
			} else {
				const fadeEndTime = now + AUDIO_SCHEDULER_SEEK_FADE_SECONDS;
				slot.gainNode.gain.cancelScheduledValues(now);
				slot.gainNode.gain.setValueAtTime(slot.gainNode.gain.value, now);
				slot.gainNode.gain.linearRampToValueAtTime(0, fadeEndTime);
				slot.player.audioSyncAnchorChanged(fadeEndTime);
				retiredSlots.set(slot, fadeEndTime);
			}

			slot.player.dispose().catch(() => {});
			if (immediate) {
				slot.gainNode.disconnect();
			}
		};

		const makePlayerForPlan = (
			plan: NormalizedAudioFeedPlan,
			initialGlobalTime: number,
		): PlayerSlot => {
			const gainNode = audioContext.createGain();
			gainNode.gain.value = 0;
			gainNode.connect(schedulerGateGainNode);

			// The feed envelope must not wait for a node to be reported as
			// "started immediately". With the keep-alive path, valid nodes can be
			// queued for the future (or saved for resume), so that gate can leave the
			// entire feed permanently muted even while the AudioContext is running.
			applyGainEnvelope(gainNode, plan, audioSyncAnchor, audioContext);

			const playerSharedAudioContext: SharedAudioContextForMediaPlayer = {
				audioContext,
				gainNode,
				audioSyncAnchor,
				scheduleAudioNode,
				unscheduleAudioNode,
			};
			const timeline = makeAudioFeedTimeline(plan);
			const player = new MediaPlayer({
				canvas: null,
				src: plan.previewSrc,
				logLevel,
				sharedAudioContext: playerSharedAudioContext,
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
				playing: true,
				sequenceOffset: schedulerStartTimeInSeconds,
				credentials: undefined,
				requestInit: undefined,
				tagType: 'audio',
				getEffects: () => [],
				getEffectChainState: () => null,
				audioTimeline: timeline,
				audioSchedulingMaxAheadSeconds: () =>
					bufferingOwner.value
						? bufferingDecodeAheadSeconds
						: schedulerConfig.decodeAheadSeconds,
			});

			const initialLocalTime = getPlayerLocalTime({
				globalCompositionTime: initialGlobalTime,
				plan,
				schedulerStartTimeInSeconds,
				fps,
			});

			const slot: PlayerSlot = {
				player,
				gainNode,
				plan,
				timeline,
				disposed: false,
			};
			slots.set(plan.trackId, slot);

			const handleInitializationFailure = (
				failure: {result: unknown} | {error: unknown},
			) => {
				if (slots.get(plan.trackId) === slot) {
					disposeSlot(slot);
				}

				if ('result' in failure) {
					// eslint-disable-next-line no-console
					console.error(
						'[AudioScheduler] Audio feed initialization did not succeed',
						{
							trackId: plan.trackId,
							src: plan.previewSrc,
							initialLocalTime,
							result: failure.result,
						},
					);
				} else {
					// eslint-disable-next-line no-console
					console.error('[AudioScheduler] Failed to initialize audio feed', {
						trackId: plan.trackId,
						src: plan.previewSrc,
						initialLocalTime,
						error: failure.error,
					});
				}
			};

			player.initialize(initialLocalTime, false, 1).then(
				(result) => {
					if (result.type !== 'success') {
						handleInitializationFailure({result});
					}
				},
				(error) => {
					handleInitializationFailure({error});
				},
			);

			return slot;
		};

		const syncToTime = (currentGlobalTime: number) => {
			if (isDisposed.value || !isPlaying()) {
				return;
			}

			disconnectRetiredSlots();

			const plansInWindow = new Set<string>();
			for (const plan of plans) {
				if (plan.ranges.length === 0) {
					continue;
				}

				const planStartTimeInSeconds =
					schedulerStartTimeInSeconds + getFeedStartTimeInSeconds(plan);
				if (
					!isAudioSchedulerEntryInWindow({
						entryStartTimeInSeconds: planStartTimeInSeconds,
						entryDurationInSeconds:
							plan.durationInSeconds - getFeedStartTimeInSeconds(plan),
						currentTimeInSeconds: currentGlobalTime,
						lookaheadSeconds: schedulerConfig.mountLookaheadSeconds,
						retainBehindSeconds: schedulerConfig.retainBehindSeconds,
					})
				) {
					continue;
				}

				plansInWindow.add(plan.trackId);
				if (!slots.has(plan.trackId)) {
					makePlayerForPlan(plan, currentGlobalTime);
				}
			}

			for (const slot of slots.values()) {
				if (!plansInWindow.has(slot.plan.trackId)) {
					disposeSlot(slot);
				}
			}
		};

		const controller: AudioSchedulerController = {syncToTime};
		controllerRef.current = controller;
		syncToTime(schedulerStartTimeInSeconds + frameRef.current / fps);
		evaluateBuffering();
		const unsubscribePlaying = subscribePlaying(() => {
			const currentGlobalTime =
				schedulerStartTimeInSeconds + frameRef.current / fps;
			syncToTime(currentGlobalTime);
			evaluateBuffering();
		});
		const unsubscribeBuffering = subscribeBuffering((state) => {
			// Video and audio share this reference-counted state. Re-evaluate
			// immediately when a video decoder acquires/releases its lease instead of
			// waiting for the next watchdog tick.
			evaluateBuffering();
			recordBufferingTransition({
				source: 'provider',
				trigger: state.buffering
					? 'provider-entered-buffering'
					: 'provider-exited-buffering',
				providerBuffering: state.buffering,
				reason: state.buffering
					? bufferingOwner.value
						? bufferingStatusRef.current.reason
						: 'external-buffering'
					: bufferingOwner.value
						? bufferingStatusRef.current.reason
						: null,
			});
		});
		const bufferingIntervalId = window.setInterval(
			evaluateBuffering,
			schedulerConfig.bufferingCheckIntervalMs,
		);

		return () => {
			isDisposed.value = true;
			window.clearInterval(bufferingIntervalId);
			unsubscribePlaying();
			unsubscribeBuffering();
			if (bufferingOwner.value) {
				bufferingOwner.value = false;
				schedulerBufferingOwnerRef.current = false;
				releaseBufferingHandle();
			}
			bufferingPositionGlobalTime.value = null;
			bufferingTargetGlobalTime.value = null;

			if (controllerRef.current === controller) {
				controllerRef.current = null;
			}

			for (const slot of slots.values()) {
				disposeSlot(slot, true);
			}

			for (const slot of retiredSlots.keys()) {
				slot.gainNode.disconnect();
			}
			audioContext.removeEventListener(
				'statechange',
				handleAudioContextStateChange,
			);

			schedulerGateGainNode.disconnect();

			retiredSlots.clear();

			slots.clear();
			if (slotsRef.current === slots) {
				slotsRef.current = new Map();
			}
		};

		// The values used to construct a MediaPlayer are intentionally captured
		// at mount. Changing them recreates all feed players.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		fps,
		buffer,
		isBuffering,
		isPlaying,
		logLevel,
		plans,
		schedulerConfig,
		schedulerStartTimeInSeconds,
		sharedAudioContext,
		subscribeBuffering,
		subscribePlaying,
	]);

	useLayoutEffect(() => {
		if (!sharedAudioContext?.audioContext) {
			return;
		}

		const {audioContext, audioSyncAnchor, audioSyncAnchorEmitter} =
			sharedAudioContext;
		const {remove} = audioSyncAnchorEmitter.subscribe((event) => {
			if (event !== 'changed') {
				return;
			}

			anchorChangesRef.current++;

			const currentGlobalTime =
				schedulerStartTimeInSeconds + frameRef.current / fps;
			const audioTime = audioContext.currentTime;
			const audioGlobalCompositionTime = audioTime - audioSyncAnchor.value;
			const expectedAudioLeadSeconds =
				audioContext.baseLatency + audioContext.outputLatency;
			const previousAnchor =
				lastObservedAnchorRef.current ?? audioSyncAnchor.value;
			const nextAnchor = audioSyncAnchor.value;
			lastObservedAnchorRef.current = nextAnchor;
			anchorEventsRef.current.push({
				frame: frameRef.current,
				audioTime,
				globalCompositionTime: currentGlobalTime,
				audioGlobalCompositionTime,
				expectedAudioLeadSeconds,
				audioVideoDriftSeconds:
					audioGlobalCompositionTime -
					currentGlobalTime -
					expectedAudioLeadSeconds,
				previousAnchor,
				nextAnchor,
				shift: nextAnchor - previousAnchor,
				audioClockMinusTimeline: audioTime - currentGlobalTime,
			});
			if (anchorEventsRef.current.length > 64) {
				anchorEventsRef.current.splice(0, anchorEventsRef.current.length - 64);
			}

			controllerRef.current?.syncToTime(currentGlobalTime);

			for (const slot of slotsRef.current.values()) {
				const now = audioContext.currentTime;
				const fadeEndTime = now + AUDIO_SCHEDULER_SEEK_FADE_SECONDS;
				slot.gainNode.gain.cancelScheduledValues(now);
				slot.gainNode.gain.setValueAtTime(slot.gainNode.gain.value, now);
				slot.gainNode.gain.linearRampToValueAtTime(0, fadeEndTime);
				slot.player.audioSyncAnchorChanged(fadeEndTime);
				const localTime = getPlayerLocalTime({
					globalCompositionTime: currentGlobalTime,
					plan: slot.plan,
					schedulerStartTimeInSeconds,
					fps,
				});
				slot.player.seekTo(localTime).catch(() => {});
				applyGainEnvelope(
					slot.gainNode,
					slot.plan,
					audioSyncAnchor,
					audioContext,
					Math.max(
						audioContext.currentTime,
						fadeEndTime + AUDIO_SCHEDULER_GAIN_GUARD_SECONDS,
					),
				);
			}
		});

		return remove;
		// The mutable slot list is intentionally read from slotsRef.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fps, schedulerStartTimeInSeconds, sharedAudioContext]);

	useLayoutEffect(() => {
		if (!sharedAudioContext?.audioContext) {
			return;
		}

		const {audioContext} = sharedAudioContext;
		const currentGlobalTime = schedulerStartTimeInSeconds + frame / fps;
		controllerRef.current?.syncToTime(currentGlobalTime);

		for (const slot of slotsRef.current.values()) {
			// Normal playback progress is not a seek. Keep the decoder iterator and
			// its queued audio alive; only wake the global queue so it can compare
			// the next chunk with the current AudioContext clock.
			slot.player.wakeAudioScheduling();
		}

		const wallTimeMs = performance.now();
		const previousFrameTiming = previousFrameTimingRef.current;
		const frameDelta = previousFrameTiming
			? frame - previousFrameTiming.frame
			: null;
		const commitIntervalMs = previousFrameTiming
			? wallTimeMs - previousFrameTiming.wallTimeMs
			: null;
		const eventLoopLagMs =
			frameDelta !== null && frameDelta > 0 && commitIntervalMs !== null
				? commitIntervalMs - (frameDelta * 1000) / fps
				: null;
		if (eventLoopLagMs !== null) {
			frameTimingRef.current.maxEventLoopLagMs = Math.max(
				frameTimingRef.current.maxEventLoopLagMs,
				eventLoopLagMs,
			);
		}

		frameTimingRef.current.lastFrameDelta = frameDelta;
		frameTimingRef.current.lastCommitIntervalMs = commitIntervalMs;
		frameTimingRef.current.lastEventLoopLagMs = eventLoopLagMs;
		previousFrameTimingRef.current = {frame, wallTimeMs};

		const audioTime = audioContext.currentTime;
		const audioGlobalCompositionTime =
			audioTime - sharedAudioContext.audioSyncAnchor.value;
		const expectedAudioLeadSeconds =
			audioContext.baseLatency + audioContext.outputLatency;
		const eventLoopStall =
			eventLoopLagMs !== null &&
			eventLoopLagMs >= AUDIO_SCHEDULER_FRAME_STALL_THRESHOLD_MS;
		const droppedFrames = frameDelta !== null && frameDelta > 1;
		if (
			previousFrameTiming &&
			frameDelta !== null &&
			commitIntervalMs !== null &&
			eventLoopLagMs !== null &&
			(eventLoopStall || droppedFrames)
		) {
			const currentAudioGlobalTime = audioGlobalCompositionTime;
			const audioVideoDriftSeconds =
				currentAudioGlobalTime - currentGlobalTime - expectedAudioLeadSeconds;
			const stall: AudioSchedulerFrameStall = {
				wallTimeMs,
				frame,
				previousFrame: previousFrameTiming.frame,
				frameDelta,
				expectedFrameDelta: 1,
				commitIntervalMs,
				expectedCommitIntervalMs: (frameDelta * 1000) / fps,
				eventLoopLagMs,
				reason: [
					droppedFrames ? 'dropped-frame' : null,
					eventLoopStall ? 'event-loop-lag' : null,
				]
					.filter((value): value is string => value !== null)
					.join('+'),
				currentVideoGlobalTime: currentGlobalTime,
				audioTime,
				currentAudioGlobalTime,
				audioVideoDriftSeconds,
				audioContextState: audioContext.state,
				providerBuffering: isBuffering(),
				schedulerBuffering: schedulerBufferingOwnerRef.current,
				bufferingActive: isBuffering() || schedulerBufferingOwnerRef.current,
				schedulerGateOpen: schedulerGateOpenRef.current,
				bufferingReason: bufferingStatusRef.current.reason,
			};
			frameStallsRef.current.push(stall);
			if (
				frameStallsRef.current.length >
				AUDIO_SCHEDULER_FRAME_STALL_HISTORY_LIMIT
			) {
				frameStallsRef.current.splice(
					0,
					frameStallsRef.current.length -
						AUDIO_SCHEDULER_FRAME_STALL_HISTORY_LIMIT,
				);
			}
		}

		if (audioTime - lastDiagnosticsAudioTimeRef.current >= 1) {
			lastDiagnosticsAudioTimeRef.current = audioTime;
			const runtime: AudioSchedulerRuntime = {
				version: AUDIO_SCHEDULER_IMPLEMENTATION_VERSION,
				config: schedulerConfig,
				frame,
				audioContext: {
					state: audioContext.state,
					time: audioTime,
					baseLatency: audioContext.baseLatency,
					outputLatency: audioContext.outputLatency,
					masterGain: sharedAudioContext.gainNode?.gain.value ?? null,
					anchor: sharedAudioContext.audioSyncAnchor.value,
					globalCompositionTime: currentGlobalTime,
					audioGlobalCompositionTime,
					expectedAudioLeadSeconds,
					audioVideoDriftSeconds:
						audioGlobalCompositionTime -
						currentGlobalTime -
						expectedAudioLeadSeconds,
					audioClockMinusTimeline: audioTime - currentGlobalTime,
				},
				queue: getAudioSchedulerQueueDiagnostics(),
				frameTiming: {...frameTimingRef.current},
				feeds: Array.from(slotsRef.current.values()).map((slot) => {
					const iteratorManager = slot.player.audioIteratorManager;
					const iterator = iteratorManager?.getAudioBufferIterator();
					const feedLocalTime = getPlayerLocalTime({
						globalCompositionTime: schedulerStartTimeInSeconds + frame / fps,
						plan: slot.plan,
						schedulerStartTimeInSeconds,
						fps,
					});
					const queuedPeriod = iterator?.getQueuedPeriod() ?? null;
					const nextSourceTime = iterator?.guessNextTimestamp() ?? null;
					const queuedCompositionUntil = queuedPeriod
						? (() => {
								const endProbe = Math.max(
									queuedPeriod.from,
									queuedPeriod.until -
										AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS,
								);
								const mappedCompositionUntil =
									slot.timeline.getCompositionTimeForSourceTime(endProbe);
								return mappedCompositionUntil === null
									? slot.plan.durationInSeconds
									: Math.min(
											slot.plan.durationInSeconds,
											mappedCompositionUntil +
												AUDIO_SCHEDULER_BUFFERING_EPSILON_SECONDS,
										);
							})()
						: null;
					const nextCompositionTime =
						nextSourceTime === null
							? null
							: slot.timeline.getCompositionTimeForSourceTime(nextSourceTime);
					const compositionAhead =
						queuedCompositionUntil === null
							? null
							: queuedCompositionUntil - feedLocalTime;
					const diagnosis =
						audioContext.state !== 'running'
							? 'audio-context-not-running'
							: (sharedAudioContext.gainNode?.gain.value ?? 0) < 0.01
								? 'master-gain-muted'
								: slot.gainNode.gain.value < 0.01
									? 'feed-gain-muted'
									: queuedPeriod === null
										? 'no-queued-audio'
										: compositionAhead !== null && compositionAhead < 0.25
											? 'queue-behind'
											: 'queued';

					return {
						trackId: slot.plan.trackId,
						localTime: feedLocalTime,
						queuedNodeCount: iterator?.getQueuedAudioNodeCount() ?? 0,
						queuedSourceFrom: queuedPeriod?.from ?? null,
						queuedSourceUntil: queuedPeriod?.until ?? null,
						queuedCompositionUntil,
						nextSourceTime,
						nextCompositionTime,
						compositionAhead,
						iteratorCount: iteratorManager?.getAudioIteratorsCreated() ?? 0,
						iteratorStartSource:
							iteratorManager?.getCurrentIteratorStartFromSecond() ?? null,
						schedulingTurnsStarted:
							iteratorManager?.getAudioSchedulingTurnsStarted() ?? 0,
						schedulingTurnsCompleted:
							iteratorManager?.getAudioSchedulingTurnsCompleted() ?? 0,
						lastTurnStartedAtAudioTime:
							iteratorManager?.getLastAudioTurnStartedAtAudioTime() ?? null,
						lastTurnCompletedAtAudioTime:
							iteratorManager?.getLastAudioTurnCompletedAtAudioTime() ?? null,
						chunksScheduled: iteratorManager?.getAudioChunksScheduled() ?? 0,
						rejectedChunks: iteratorManager?.getAudioChunksRejected() ?? 0,
						lastRejectReason:
							iteratorManager?.getLastAudioChunkRejectionReason() ?? null,
						lastChunkScheduledAtAudioTime:
							iteratorManager?.getLastAudioChunkScheduledAtAudioTime() ?? null,
						lastChunkScheduledSourceTime:
							iteratorManager?.getLastAudioChunkScheduledSourceTime() ?? null,
						lastChunkRejectedAtAudioTime:
							iteratorManager?.getLastAudioChunkRejectedAtAudioTime() ?? null,
						scheduledSeconds:
							iteratorManager?.getTotalAudioScheduledInSeconds() ?? 0,
						feedGain: slot.gainNode.gain.value,
						diagnosis,
					};
				}),
				buffering: {
					...bufferingStatusRef.current,
					affectedFeedIds: [...bufferingStatusRef.current.affectedFeedIds],
				},
				bufferHealth: bufferHealthRef.current.map((feed) => ({...feed})),
				anchorChanges: anchorChangesRef.current,
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
		}
	}, [fps, frame, schedulerStartTimeInSeconds, sharedAudioContext]);

	return null;
};
