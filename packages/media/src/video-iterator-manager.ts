import type {InputVideoTrack, WrappedCanvas} from 'mediabunny';
import {CanvasSink} from 'mediabunny';
import type {
	EffectChainState,
	EffectDefinitionAndStack,
	LogLevel,
} from 'remotion';
import {Internals} from 'remotion';
import type {
	DelayPlaybackIfNotPremounting,
	DelayPlaybackMetadata,
} from './delay-playback-if-not-premounting';
import {roundTo4Digits} from './helpers/round-to-4-digits';
import type {Nonce} from './nonce-manager';
import {makePrewarmedVideoIteratorCache} from './prewarm-iterator-for-looping';
import {
	createVideoIterator,
	type VideoIterator,
} from './video/video-preview-iterator';

const {runEffectChain} = Internals;

export const isSequentialMediaTimeAdvance = ({
	previousTime,
	newTime,
	fps,
	playbackRate,
	isPlaying,
}: {
	previousTime: number;
	newTime: number;
	fps: number;
	playbackRate: number;
	isPlaying: boolean;
}) => {
	if (!isPlaying || newTime < previousTime) {
		return false;
	}

	const maximumSequentialAdvance = Math.abs(playbackRate) / fps;
	return (
		roundTo4Digits(newTime - previousTime) <=
		roundTo4Digits(maximumSequentialAdvance)
	);
};

export const videoIteratorManager = async ({
	delayPlaybackHandleIfNotPremounting,
	canvas,
	context,
	drawDebugOverlay,
	logLevel,
	getOnVideoFrameCallback,
	videoTrack,
	getLoopSegmentMediaEndTimestamp,
	getStartTime,
	getIsLooping,
	getEffects,
	getEffectChainState,
	requireCanvasForVideo = false,
}: {
	videoTrack: InputVideoTrack;
	delayPlaybackHandleIfNotPremounting: (
		metadata?: DelayPlaybackMetadata,
	) => DelayPlaybackIfNotPremounting;
	context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
	canvas: OffscreenCanvas | HTMLCanvasElement | null;
	getOnVideoFrameCallback: () => null | ((frame: CanvasImageSource) => void);
	logLevel: LogLevel;
	drawDebugOverlay: () => void;
	getLoopSegmentMediaEndTimestamp: () => number;
	getStartTime: () => number;
	getIsLooping: () => boolean;
	getEffects: () => EffectDefinitionAndStack<unknown>[];
	getEffectChainState: (
		width: number,
		height: number,
	) => EffectChainState | null;
	requireCanvasForVideo?: boolean;
}) => {
	let videoIteratorsCreated = 0;
	let videoFrameIterator: VideoIterator | null = null;
	let framesRendered = 0;
	let currentDelayHandle: {unblock: () => void} | null = null;
	let paintReadinessHandle: DelayPlaybackIfNotPremounting | null = null;
	let lastDrawnFrame: WrappedCanvas | null = null;
	let currentSeek: number | null = null;
	let iteratorStartGeneration = 0;

	const clearLastDrawnFrame = () => {
		lastDrawnFrame = null;
	};

	if (canvas) {
		const displayWidth = await videoTrack.getDisplayWidth();
		const displayHeight = await videoTrack.getDisplayHeight();
		if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
			canvas.width = displayWidth;
			canvas.height = displayHeight;
		}
	}

	const canvasSink = new CanvasSink(videoTrack, {
		// Match the preview look-ahead buffer size. CanvasSink may reuse pooled
		// canvas objects for later decoded frames, so Remotion copies pixels into
		// stable canvases before retaining frames across seeks/peeks.
		poolSize: 3,
		fit: 'contain',
		alpha: true,
	});

	const prewarmedVideoIteratorCache =
		makePrewarmedVideoIteratorCache(canvasSink);

	const blockUntilVideoCanPaint = ({
		reason,
		frameTime,
	}: {
		reason: string;
		frameTime?: number | null;
	}) => {
		if (!requireCanvasForVideo || paintReadinessHandle) {
			return;
		}

		paintReadinessHandle = delayPlaybackHandleIfNotPremounting({
			operation: 'video-paint-readiness',
			renderer: 'mediabunny-canvas',
			mediaType: 'video',
			reason,
			requestedTimeInSeconds: currentSeek,
			frameTimeInSeconds: frameTime ?? null,
		});
	};

	const releaseVideoPaintReadiness = () => {
		if (!paintReadinessHandle) {
			return;
		}

		paintReadinessHandle.unblock();
		paintReadinessHandle = null;
	};

	const paintFrame = async (frame: WrappedCanvas): Promise<boolean> => {
		if (!context || !canvas) {
			if (!requireCanvasForVideo) {
				// Keep the low-level iterator manager usable for decode-only callers
				// and headless tests. Visual MediaPlayer instances opt into the
				// readiness contract through requireCanvasForVideo.
				return true;
			}

			blockUntilVideoCanPaint({reason: 'missing-canvas-or-context'});
			return false;
		}

		try {
			const effects = getEffects();
			const chainState = getEffectChainState(canvas.width, canvas.height);
			if (
				effects.length > 0 &&
				chainState &&
				canvas instanceof HTMLCanvasElement
			) {
				await runEffectChain({
					state: chainState,
					source: frame.canvas,
					effects,
					output: canvas,
					width: canvas.width,
					height: canvas.height,
				});
			} else {
				context.clearRect(0, 0, canvas.width, canvas.height);
				context.drawImage(frame.canvas, 0, 0);
			}
		} catch (error) {
			// A decoded frame is not ready for playback until the visual target has
			// actually accepted it. Keep the global buffer blocked when painting
			// fails, and allow a later frame to retry the same target.
			blockUntilVideoCanPaint({
				reason: 'paint-error',
				frameTime: frame.timestamp,
			});
			Internals.Log.verbose(
				{logLevel, tag: '@remotion/media'},
				'[MediaPlayer] Could not paint decoded video frame; keeping playback buffered',
				error,
			);
			return false;
		}

		releaseVideoPaintReadiness();
		return true;
	};

	const drawFrame = async (frame: WrappedCanvas): Promise<boolean> => {
		const painted = await paintFrame(frame);
		if (!painted) {
			return false;
		}

		lastDrawnFrame = frame;

		framesRendered++;

		drawDebugOverlay();
		const callback = getOnVideoFrameCallback();
		if (callback) {
			callback(frame.canvas);
		}

		Internals.Log.trace(
			{logLevel, tag: '@remotion/media'},
			`[MediaPlayer] Drew frame ${frame.timestamp.toFixed(3)}s`,
		);

		return true;
	};

	const redrawCurrentFrame = async (): Promise<void> => {
		if (!lastDrawnFrame) {
			return;
		}

		const painted = await paintFrame(lastDrawnFrame);
		if (!painted) {
			return;
		}

		drawDebugOverlay();
		const callback = getOnVideoFrameCallback();
		if (callback) {
			callback(lastDrawnFrame.canvas);
		}

		Internals.Log.trace(
			{logLevel, tag: '@remotion/media'},
			`[MediaPlayer] Redrew frame ${lastDrawnFrame.timestamp.toFixed(3)}s with updated effects`,
		);
	};

	const startVideoIterator = async (
		timeToSeek: number,
		nonce: Nonce,
	): Promise<void> => {
		const generation = ++iteratorStartGeneration;
		const previousIterator = videoFrameIterator;

		// Do not tear down the current iterator until the replacement has a frame
		// that was successfully painted. This is the activation handoff used by
		// premounted Sequences: the old frame remains available while the new
		// iterator is being decoded, and a failed/stale replacement cannot leave
		// the canvas blank.
		using delayHandle = delayPlaybackHandleIfNotPremounting({
			operation: 'video-decode-iterator',
			renderer: 'mediabunny-canvas',
			mediaType: 'video',
			reason: 'waiting-for-initial-video-frame',
			requestedTimeInSeconds: timeToSeek,
		});
		currentDelayHandle = delayHandle;
		currentSeek = timeToSeek;

		const iterator = await createVideoIterator(
			timeToSeek,
			prewarmedVideoIteratorCache,
		);
		videoIteratorsCreated++;

		if (generation !== iteratorStartGeneration) {
			iterator.destroy();
			return;
		}

		if (iterator.isDestroyed()) {
			return;
		}

		if (nonce.isStale()) {
			// During a paused scrub, every seek goes stale before its decode
			// lands, so returning undrawn would discard every frame and freeze
			// the preview. Painting is safe: the newer seek always lands last.
			if (iterator.initialFrame) {
				const painted = await drawFrame(iterator.initialFrame);
				if (!painted) {
					iterator.destroy();
					return;
				}
			}

			if (previousIterator && previousIterator !== iterator) {
				previousIterator.destroy();
			}
			videoFrameIterator = iterator;
			return;
		}

		if (iterator.isDestroyed()) {
			return;
		}

		if (!iterator.initialFrame) {
			// media ended
			iterator.destroy();
			return;
		}

		const painted = await drawFrame(iterator.initialFrame);
		if (!painted || generation !== iteratorStartGeneration) {
			iterator.destroy();
			return;
		}

		if (previousIterator && previousIterator !== iterator) {
			previousIterator.destroy();
		}
		videoFrameIterator = iterator;
	};

	const seek = async ({
		newTime,
		nonce,
		fps,
		playbackRate,
		isPlaying,
	}: {
		newTime: number;
		nonce: Nonce;
		fps: number;
		playbackRate: number;
		isPlaying: boolean;
	}) => {
		if (!videoFrameIterator) {
			return;
		}

		if (
			currentSeek !== null &&
			roundTo4Digits(currentSeek) === roundTo4Digits(newTime)
		) {
			return;
		}

		const previousTime = currentSeek;
		currentSeek = newTime;

		if (getIsLooping()) {
			// If less than 1 second from the end away, we pre-warm a new iterator
			if (getLoopSegmentMediaEndTimestamp() - newTime < 1) {
				prewarmedVideoIteratorCache.prewarmIteratorForLooping({
					timeToSeek: getStartTime(),
				});
			}
		}

		const pendingFrameBehavior =
			previousTime !== null &&
			isSequentialMediaTimeAdvance({
				previousTime,
				newTime,
				fps,
				playbackRate,
				isPlaying,
			})
				? 'wait'
				: 'restart-iterator';
		const videoSatisfyResult = await videoFrameIterator.tryToSatisfySeek(
			newTime,
			{
				pendingFrameBehavior,
				shouldContinue: () => !nonce.isStale(),
			},
		);

		// Doing this before the staleness check, because
		// frame might be better than what we currently have
		// TODO: check if this is actually true
		if (videoSatisfyResult.type === 'satisfied') {
			await drawFrame(videoSatisfyResult.frame);
			return;
		}

		if (nonce.isStale()) {
			return;
		}

		await startVideoIterator(newTime, nonce);
	};

	return {
		startVideoIterator,
		getVideoIteratorsCreated: () => videoIteratorsCreated,
		seek,
		destroy: () => {
			iteratorStartGeneration++;
			clearLastDrawnFrame();
			prewarmedVideoIteratorCache.destroy();
			videoFrameIterator?.destroy();
			if (context && canvas) {
				context.clearRect(0, 0, canvas.width, canvas.height);
			}

			if (currentDelayHandle) {
				currentDelayHandle.unblock();
				currentDelayHandle = null;
			}

			if (paintReadinessHandle) {
				paintReadinessHandle.unblock();
				paintReadinessHandle = null;
			}

			videoFrameIterator = null;
		},
		getVideoFrameIterator: () => videoFrameIterator,
		drawFrame,
		redrawCurrentFrame,
		getFramesRendered: () => framesRendered,
	};
};

export type VideoIteratorManager = Awaited<
	ReturnType<typeof videoIteratorManager>
>;
