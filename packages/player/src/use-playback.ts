import {useLayoutEffect} from 'react';
/* eslint-disable @typescript-eslint/no-use-before-define */
import {useContext, useEffect, useRef} from 'react';
import type {RemotionAudioContextState} from 'remotion';
import {Internals} from 'remotion';
import type {BrowserMediaControlsBehavior} from './browser-mediasession.js';
import {useBrowserMediaSession} from './browser-mediasession.js';
import {calculateNextFrame} from './calculate-next-frame.js';
import {useIsBackgrounded} from './is-backgrounded.js';
import {setGlobalTimeAnchor} from './set-global-time-anchor.js';
import {type UsePlayerMethods, usePlayerMethods} from './use-player-methods.js';

const shouldForceAnchorChange = (newState: RemotionAudioContextState) => {
	if (newState === 'suspended' || newState === 'running-to-suspended') {
		return true;
	}

	if (
		newState === 'closed' ||
		newState === 'interrupted' ||
		newState === 'running' ||
		newState === 'suspended-to-running'
	) {
		return false;
	}

	throw new Error(
		`Unexpected audio context state: ${newState satisfies never}`,
	);
};

const getFrameFromSharedTransportClock = ({
	audioContext,
	audioSyncAnchor,
	playbackRate,
	fps,
	currentFrame,
	actualFirstFrame,
	actualLastFrame,
	shouldLoop,
}: {
	audioContext: AudioContext;
	audioSyncAnchor: {readonly value: number};
	playbackRate: number;
	fps: number;
	currentFrame: number;
	actualFirstFrame: number;
	actualLastFrame: number;
	shouldLoop: boolean;
}): {nextFrame: number; hasEnded: boolean} => {
	// The anchor maps the continuously running AudioContext clock onto the
	// composition timeline. Deriving the frame from this same value means the
	// renderer and every scheduled AudioBufferSourceNode consume one transport
	// clock instead of advancing from two independent wall clocks.
	const globalCompositionTime =
		(audioContext.currentTime - audioSyncAnchor.value) * playbackRate;
	const rawFrame = (playbackRate < 0 ? Math.ceil : Math.floor)(
		globalCompositionTime * fps,
	);
	const currentFrameOutsideRange =
		currentFrame < actualFirstFrame || currentFrame > actualLastFrame;
	const nextFrameOutsideRange =
		rawFrame < actualFirstFrame || rawFrame > actualLastFrame;
	const hasEnded =
		!shouldLoop && nextFrameOutsideRange && !currentFrameOutsideRange;

	if (!shouldLoop) {
		if (hasEnded) {
			return {
				nextFrame: playbackRate < 0 ? actualLastFrame : actualFirstFrame,
				hasEnded: true,
			};
		}

		return {
			nextFrame: Math.min(
				actualLastFrame,
				Math.max(actualFirstFrame, rawFrame),
			),
			hasEnded: false,
		};
	}

	const loopDurationInFrames = actualLastFrame - actualFirstFrame + 1;
	const loopOffset =
		(((rawFrame - actualFirstFrame) % loopDurationInFrames) +
			loopDurationInFrames) %
		loopDurationInFrames;

	return {
		nextFrame: actualFirstFrame + loopOffset,
		hasEnded: false,
	};
};

export const usePlayback = ({
	loop,
	playbackRate,
	moveToBeginningWhenEnded,
	inFrame,
	outFrame,
	browserMediaControlsBehavior,
	getCurrentFrame,
	muted,
}: {
	loop: boolean;
	playbackRate: number;
	moveToBeginningWhenEnded: boolean;
	inFrame: number | null;
	outFrame: number | null;
	browserMediaControlsBehavior: BrowserMediaControlsBehavior;
	getCurrentFrame: UsePlayerMethods['getCurrentFrame'];
	muted: boolean;
}) => {
	const config = Internals.useUnsafeVideoConfig();
	const frame = Internals.Timeline.useTimelinePosition();
	const playing = Internals.usePlaying();
	const {pause, emitter, isPlaying} = usePlayerMethods();
	const setFrame = Internals.Timeline.useTimelineSetFrame();
	const sharedAudioContext = useContext(Internals.SharedAudioContext);
	const {setPlayerMuted} = useContext(Internals.SetMediaVolumeContext);
	const {isBuffering, subscribeBuffering} = useContext(
		Internals.SetTimelineContext,
	);
	const logLevel = Internals.useLogLevel();

	// requestAnimationFrame() does not work if the tab is not active.
	// This means that audio will keep playing even if it has ended.
	// In that case, we use setTimeout() instead.
	const isBackgroundedRef = useIsBackgrounded();

	const lastTimeUpdateTimestamp = useRef<number>(0);
	const wasPlayingRef = useRef(false);
	const pendingExplicitSeekFrameRef = useRef<number | null>(null);

	useBrowserMediaSession({
		browserMediaControlsBehavior,
		playbackRate,
		videoConfig: config,
	});

	// Update time anchor when seeking:
	// If the user clicked on a different time in the timeline, we need to re-sync the anchor
	useLayoutEffect(() => {
		const pendingExplicitSeekFrame = pendingExplicitSeekFrameRef.current;

		if (!sharedAudioContext) {
			pendingExplicitSeekFrameRef.current = null;
			return;
		}

		if (!sharedAudioContext.audioContext) {
			pendingExplicitSeekFrameRef.current = null;
			return;
		}

		if (!config) {
			pendingExplicitSeekFrameRef.current = null;
			return;
		}

		if (muted) {
			pendingExplicitSeekFrameRef.current = null;
			return;
		}

		// In keep-alive mode, resume() below re-anchors and dispatches the change
		// after arming the shared master-gain barrier. Do not let this layout effect
		// dispatch a stale pre-resume anchor first; that would make schedulers tear
		// down and rebuild their sources twice during one pause/resume cycle.
		if (
			playing &&
			sharedAudioContext._experimentalKeepAudioContextAlive &&
			!wasPlayingRef.current
		) {
			return;
		}

		const isExplicitSeek = pendingExplicitSeekFrame === frame;
		// In keep-alive mode, a normal frame-clock correction is destructive: it
		// tells every audio iterator to tear down its already-buffered sources and
		// decode again. The context clock is still a valid transport clock, so keep
		// the existing queue intact during ordinary drift. Explicit seeks and the
		// pause/resume path above still force a re-anchor.
		const shouldApplyAutomaticAnchorChange =
			!sharedAudioContext._experimentalKeepAudioContextAlive || frame === 0;
		if (isExplicitSeek || shouldApplyAutomaticAnchorChange) {
			const changed = setGlobalTimeAnchor({
				audioContext: sharedAudioContext.audioContext,
				audioSyncAnchor: sharedAudioContext.audioSyncAnchor,
				absoluteTimeInSeconds: frame / config.fps,
				globalPlaybackRate: playbackRate,
				logLevel,
				// A seek must always re-anchor, even when the destination is less than
				// the normal frame-quantization threshold away from the old anchor.
				force: isExplicitSeek,
			});
			if (changed) {
				sharedAudioContext.audioSyncAnchorEmitter.dispatch('changed');
			}
		}

		if (pendingExplicitSeekFrame === frame) {
			pendingExplicitSeekFrameRef.current = null;
		} else if (pendingExplicitSeekFrame !== null) {
			// The pending seek was superseded before React committed its frame.
			pendingExplicitSeekFrameRef.current = null;
		}
	}, [
		config,
		frame,
		logLevel,
		playbackRate,
		playing,
		sharedAudioContext,
		muted,
	]);

	// PlayerRef.seekTo() pauses before dispatching `seeked`, and dispatches the
	// event before React has committed the new timeline frame. Only remember the
	// seek here. The anchor effect above consumes it after the commit, when media
	// schedulers read the new frame instead of the previous one.
	useLayoutEffect(() => {
		const onSeek = ({detail}: {detail: {frame: number}}) => {
			// Keep the previous value as well as the live store value because
			// seekTo() pauses before dispatching this event.
			if (!isPlaying() && !wasPlayingRef.current) {
				return;
			}

			pendingExplicitSeekFrameRef.current = detail.frame;
		};

		emitter.addEventListener('seeked', onSeek);
		return () => emitter.removeEventListener('seeked', onSeek);
	}, [emitter, isPlaying]);

	// When the audio context is suspended, we use the opportunity to
	// re-anchor the time to be exact.
	useLayoutEffect(() => {
		const audioContext = sharedAudioContext?.audioContext;
		if (!audioContext) {
			return;
		}

		if (!config) {
			return;
		}

		if (muted) {
			return;
		}

		const callback = () => {
			// Buffering is a shared transport pause, not a seek. Re-anchoring here
			// would invalidate the timestamps that the scheduler is preserving while
			// the audio and video pipelines refill.
			if (isBuffering()) {
				return;
			}

			const newState = sharedAudioContext?.getAudioContextState();
			if (newState && shouldForceAnchorChange(newState)) {
				setGlobalTimeAnchor({
					audioContext,
					audioSyncAnchor: sharedAudioContext.audioSyncAnchor,
					absoluteTimeInSeconds: getCurrentFrame() / config.fps,
					globalPlaybackRate: playbackRate,
					logLevel,
					force: true,
				});
			}
		};

		audioContext?.addEventListener('statechange', callback);
		return () => {
			audioContext?.removeEventListener('statechange', callback);
		};
	}, [
		config,
		getCurrentFrame,
		isBuffering,
		logLevel,
		muted,
		playbackRate,
		sharedAudioContext,
	]);

	useEffect(() => {
		if (!config) {
			return;
		}

		if (!playing) {
			wasPlayingRef.current = false;
			sharedAudioContext?.suspend?.();
			return;
		}

		const wasPlaying = wasPlayingRef.current;
		wasPlayingRef.current = true;

		if (
			sharedAudioContext?._experimentalKeepAudioContextAlive &&
			sharedAudioContext.audioContext &&
			!muted &&
			!isBuffering()
		) {
			// Resume first. In keep-alive mode this arms a short barrier: existing
			// sources remain silent until the anchor change below has invalidated
			// their iterators. This ordering prevents a paused source from being
			// exposed at its stale waveform position.
			sharedAudioContext.resume();

			// With _experimentalKeepAudioContextAlive, the context clock keeps
			// running while frames are not advancing (pauses and buffering), so
			// the anchor is stale by the length of the stall. Re-anchor from the
			// current frame and tell the audio iterators to reschedule.
			const changed = setGlobalTimeAnchor({
				audioContext: sharedAudioContext.audioContext,
				audioSyncAnchor: sharedAudioContext.audioSyncAnchor,
				absoluteTimeInSeconds: getCurrentFrame() / config.fps,
				globalPlaybackRate: playbackRate,
				logLevel,
				force: true,
			});
			// A pause followed by play can have the same numeric anchor when no
			// time elapsed. It still needs a change notification to flush nodes
			// that were scheduled before the pause.
			if (changed || !wasPlaying) {
				sharedAudioContext.audioSyncAnchorEmitter.dispatch('changed');
			}
		}

		let hasBeenStopped = false;
		let audioContextFailed = false;
		let reqAnimFrameCall:
			| {
					type: 'raf';
					id: number;
			  }
			| {
					type: 'timeout';
					id: Timer;
			  }
			| null = null;
		let startedTime = performance.now();
		let framesAdvanced = 0;
		const useSharedTransportClock = Boolean(
			sharedAudioContext?._experimentalKeepAudioContextAlive &&
			sharedAudioContext.audioContext &&
			!muted,
		);

		const cancelQueuedFrame = () => {
			if (reqAnimFrameCall !== null) {
				if (reqAnimFrameCall.type === 'raf') {
					cancelAnimationFrame(reqAnimFrameCall.id);
				} else {
					clearTimeout(reqAnimFrameCall.id);
				}
			}
		};

		const stop = () => {
			hasBeenStopped = true;
			cancelQueuedFrame();
		};

		const callback = () => {
			if (hasBeenStopped) {
				return;
			}

			if (!isPlaying()) {
				sharedAudioContext?.suspend?.();
				return;
			}

			if (!muted && !audioContextFailed && !isBuffering()) {
				sharedAudioContext?.resume?.();
			}

			const actualLastFrame = outFrame ?? config.durationInFrames - 1;
			const actualFirstFrame = inFrame ?? 0;

			const currentFrame = getCurrentFrame();
			let nextFrame: number;
			let hasEnded: boolean;
			if (useSharedTransportClock && sharedAudioContext?.audioContext) {
				const result = getFrameFromSharedTransportClock({
					audioContext: sharedAudioContext.audioContext,
					audioSyncAnchor: sharedAudioContext.audioSyncAnchor,
					playbackRate,
					fps: config.fps,
					currentFrame,
					actualFirstFrame,
					actualLastFrame,
					shouldLoop: loop,
				});
				nextFrame = result.nextFrame;
				hasEnded = result.hasEnded;
			} else {
				const {
					nextFrame: calculatedNextFrame,
					framesToAdvance,
					hasEnded: calculatedHasEnded,
				} = calculateNextFrame({
					time: performance.now() - startedTime,
					currentFrame,
					playbackSpeed: playbackRate,
					fps: config.fps,
					actualFirstFrame,
					actualLastFrame,
					framesAdvanced,
					shouldLoop: loop,
				});
				framesAdvanced += framesToAdvance;
				nextFrame = calculatedNextFrame;
				hasEnded = calculatedHasEnded;
			}

			if (
				nextFrame !== getCurrentFrame() &&
				(!hasEnded || moveToBeginningWhenEnded) &&
				!isBuffering()
			) {
				setFrame((c) => ({...c, [config.id]: nextFrame}));
			}

			if (hasEnded) {
				stop();
				pause();
				emitter.dispatchEnded();
				return;
			}

			queueNextFrame();
		};

		const queueNextFrame = () => {
			if (hasBeenStopped) {
				return;
			}

			const getIsResumingAudioContext = audioContextFailed
				? null
				: (sharedAudioContext?.getIsResumingAudioContext?.() ?? null);
			if (getIsResumingAudioContext !== null && !muted) {
				getIsResumingAudioContext.then((result) => {
					if (hasBeenStopped) {
						return;
					}

					if (result === 'failed') {
						audioContextFailed = true;
						sharedAudioContext?.suspend();
						setPlayerMuted(true);
					}

					startedTime = performance.now();
					framesAdvanced = 0;
					queueNextFrame();
				});

				return;
			}

			if (isBuffering()) {
				if (!muted && !audioContextFailed) {
					sharedAudioContext?.suspendForBuffering?.();
				}

				const unsubscribe = subscribeBuffering((state) => {
					if (state.buffering) {
						return;
					}

					unsubscribe();
					if (
						!muted &&
						!audioContextFailed &&
						sharedAudioContext?._experimentalKeepAudioContextAlive
					) {
						sharedAudioContext.resume();
					}

					startedTime = performance.now();
					framesAdvanced = 0;
					queueNextFrame();
				});
				return;
			}

			if (isBackgroundedRef.current) {
				reqAnimFrameCall = {
					type: 'timeout',
					// Note: Most likely, this will not be 1000 / fps, but the browser will throttle it to ~1/sec.
					id: setTimeout(callback, 1000 / config.fps),
				};
				return;
			}

			reqAnimFrameCall = {type: 'raf', id: requestAnimationFrame(callback)};
		};

		queueNextFrame();

		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				return;
			}

			// If tab goes into the background, cancel requestAnimationFrame() and update immediately.
			// , so the transition to setTimeout() can be fulfilled.
			cancelQueuedFrame();
			callback();
		};

		window.addEventListener('visibilitychange', onVisibilityChange);

		return () => {
			window.removeEventListener('visibilitychange', onVisibilityChange);
			stop();
		};
	}, [
		config,
		loop,
		pause,
		playing,
		setFrame,
		emitter,
		playbackRate,
		inFrame,
		outFrame,
		moveToBeginningWhenEnded,
		isBackgroundedRef,
		getCurrentFrame,
		isBuffering,
		isPlaying,
		sharedAudioContext,
		setPlayerMuted,
		subscribeBuffering,
		logLevel,
		muted,
	]);

	useEffect(() => {
		const now = performance.now();
		const timeSinceLastUpdate = now - lastTimeUpdateTimestamp.current;

		if (timeSinceLastUpdate >= 250) {
			emitter.dispatchTimeUpdate({frame});
			lastTimeUpdateTimestamp.current = now;
			return;
		}

		const timeoutId = setTimeout(() => {
			emitter.dispatchTimeUpdate({frame});
			lastTimeUpdateTimestamp.current = performance.now();
		}, 250 - timeSinceLastUpdate);

		return () => clearTimeout(timeoutId);
	}, [emitter, frame]);

	useEffect(() => {
		emitter.dispatchFrameUpdate({frame});
	}, [emitter, frame]);
};
