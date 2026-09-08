import React, {
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import type {LogLevel} from './log';
import {LogLevelContext} from './log-level-context';
import {playbackLogging} from './playback-logging';
import {SetTimelineContext} from './TimelineContext.js';
import {useRemotionEnvironment} from './use-remotion-environment';

/**
 * Extra information attached to a buffering lease.
 *
 * This intentionally lives next to the buffer manager rather than in the
 * media components. It lets a diagnostic dump answer which exact media
 * pipeline owns the shared buffering state at any point in time.
 */
export type BufferBlockMetadata = Readonly<{
	label?: string;
	source?: string | null;
	operation?: string | null;
	renderer?: string | null;
	instanceId?: string | null;
	mediaType?: 'audio' | 'video' | 'image' | 'unknown';
	src?: string | null;
	reason?: string | null;
	requestedTimeInSeconds?: number | null;
	unloopedTimeInSeconds?: number | null;
	frameTimeInSeconds?: number | null;
	sequenceOffsetInSeconds?: number | null;
	sequenceDurationInFrames?: number | null;
	isPremounting?: boolean;
	isPostmounting?: boolean;
	requireCanvasForVideo?: boolean | null;
	stack?: string | null;
	readyState?: number | null;
	networkState?: number | null;
	currentTime?: number | null;
	duration?: number | null;
	paused?: boolean;
	seeking?: boolean;
	buffered?: ReadonlyArray<Readonly<{start: number; end: number}>>;
}>;

export type BufferingBlockEvent = Readonly<{
	type: 'acquired' | 'released';
	id: number;
	wallTimeMs: number;
	ageMs: number | null;
	activeBlockCount: number;
	unblockReason: string | null;
	metadata: BufferBlockMetadata;
}>;

export type BufferingDiagnostics = Readonly<{
	capturedAtMs: number;
	providerBuffering: boolean;
	activeBlockCount: number;
	activeBlocks: ReadonlyArray<
		Readonly<{
			id: number;
			acquiredAtMs: number;
			ageMs: number;
			metadata: BufferBlockMetadata;
		}>
	>;
	events: ReadonlyArray<BufferingBlockEvent>;
	exitStabilityMs: number;
}>;

type ActiveBufferBlock = {
	id: number;
	acquiredAtMs: number;
	metadata: BufferBlockMetadata;
};

type BufferManager = {
	addBlock: (metadata?: BufferBlockMetadata) => {
		unblock: (reason?: string) => void;
	};
	getBufferingDiagnostics: () => BufferingDiagnostics;
};

// Keep this editable while investigating playback behavior. A short gap
// between one media element releasing its lease and another acquiring one is
// not a real recovery; keeping the shared state active across that gap avoids
// repeatedly suspending and resuming the one native AudioContext.
export const BUFFERING_EXIT_STABILITY_MS = 500;
const BUFFERING_EVENT_HISTORY_LIMIT = 256;

const getBufferingNow = () =>
	typeof performance === 'undefined' ? Date.now() : performance.now();

const cloneMetadata = (metadata: BufferBlockMetadata) => ({
	...metadata,
	buffered: metadata.buffered?.map((range) => ({...range})),
});

const useBufferManager = (
	logLevel: LogLevel,
	mountTime: number | null,
	setBuffering: (buffering: boolean) => void,
	isBuffering: () => boolean,
): BufferManager => {
	const [blockCount, setBlockCount] = useState(0);
	const activeBlocksRef = useRef<Map<number, ActiveBufferBlock>>(new Map());
	const blockEventsRef = useRef<BufferingBlockEvent[]>([]);
	const nextBlockIdRef = useRef(0);
	const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const env = useRemotionEnvironment();
	const rendering = env.isRendering;

	const recordBlockEvent = useCallback((event: BufferingBlockEvent) => {
		blockEventsRef.current.push({
			...event,
			metadata: cloneMetadata(event.metadata),
		});
		if (blockEventsRef.current.length > BUFFERING_EVENT_HISTORY_LIMIT) {
			blockEventsRef.current.splice(
				0,
				blockEventsRef.current.length - BUFFERING_EVENT_HISTORY_LIMIT,
			);
		}
	}, []);

	const addBlock = useCallback(
		(metadata: BufferBlockMetadata = {}) => {
			if (rendering) {
				return {
					unblock: (_reason?: string) => undefined,
				};
			}

			const id = nextBlockIdRef.current++;
			const acquiredAtMs = getBufferingNow();
			const activeBlock: ActiveBufferBlock = {
				id,
				acquiredAtMs,
				metadata: cloneMetadata(metadata),
			};
			activeBlocksRef.current.set(id, activeBlock);
			recordBlockEvent({
				type: 'acquired',
				id,
				wallTimeMs: acquiredAtMs,
				ageMs: null,
				activeBlockCount: activeBlocksRef.current.size,
				unblockReason: null,
				metadata: activeBlock.metadata,
			});

			let unblocked = false;

			setBlockCount((count) => count + 1);
			return {
				unblock: (reason?: string) => {
					if (unblocked) {
						return;
					}

					unblocked = true;
					const activeBlock = activeBlocksRef.current.get(id);
					if (!activeBlock) {
						return;
					}

					activeBlocksRef.current.delete(id);
					const wallTimeMs = getBufferingNow();
					recordBlockEvent({
						type: 'released',
						id,
						wallTimeMs,
						ageMs: wallTimeMs - activeBlock.acquiredAtMs,
						activeBlockCount: activeBlocksRef.current.size,
						unblockReason: reason ?? null,
						metadata: activeBlock.metadata,
					});
					setBlockCount((count) => Math.max(0, count - 1));
				},
			};
		},
		[recordBlockEvent, rendering],
	);

	useEffect(() => {
		if (exitTimerRef.current !== null) {
			clearTimeout(exitTimerRef.current);
			exitTimerRef.current = null;
		}

		if (rendering) {
			return;
		}

		// Only fire on the `false -> true` transition: adding a block while
		// already buffering (e.g. a second media element starts loading) must
		// not re-dispatch `waiting` to listeners.
		if (blockCount > 0 && !isBuffering()) {
			setBuffering(true);
			playbackLogging({
				logLevel,
				message: 'Player is entering buffer state',
				mountTime,
				tag: 'player',
			});
			return;
		}

		if (blockCount === 0 && isBuffering()) {
			// Do not publish the false edge immediately. Dense media boundaries can
			// release one block and acquire the next one in separate React commits.
			// The timeout is cancelled as soon as a new block arrives.
			const timer = setTimeout(() => {
				exitTimerRef.current = null;
				if (blockCount !== 0 || !isBuffering()) {
					return;
				}

				setBuffering(false);
				playbackLogging({
					logLevel,
					message: `Player is exiting buffer state after ${BUFFERING_EXIT_STABILITY_MS}ms of stable clearance`,
					mountTime,
					tag: 'player',
				});
			}, BUFFERING_EXIT_STABILITY_MS);
			exitTimerRef.current = timer;
			return () => clearTimeout(timer);
		}

		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [blockCount, isBuffering, logLevel, mountTime, rendering, setBuffering]);

	const getBufferingDiagnostics = useCallback((): BufferingDiagnostics => {
		const capturedAtMs = getBufferingNow();
		return {
			capturedAtMs,
			providerBuffering: isBuffering(),
			activeBlockCount: activeBlocksRef.current.size,
			activeBlocks: Array.from(activeBlocksRef.current.values()).map(
				(block) => ({
					id: block.id,
					acquiredAtMs: block.acquiredAtMs,
					ageMs: capturedAtMs - block.acquiredAtMs,
					metadata: cloneMetadata(block.metadata),
				}),
			),
			events: blockEventsRef.current.map((event) => ({
				...event,
				metadata: cloneMetadata(event.metadata),
			})),
			exitStabilityMs: BUFFERING_EXIT_STABILITY_MS,
		};
	}, [isBuffering]);

	return useMemo(
		() => ({addBlock, getBufferingDiagnostics}),
		[addBlock, getBufferingDiagnostics],
	);
};

export const BufferingContextReact = React.createContext<BufferManager | null>(
	null,
);

export const BufferingProvider: React.FC<{
	readonly children: React.ReactNode;
}> = ({children}) => {
	const {logLevel, mountTime} = useContext(LogLevelContext);
	const {isBuffering, setBuffering} = useContext(SetTimelineContext);
	const bufferManager = useBufferManager(
		logLevel ?? 'info',
		mountTime,
		setBuffering,
		isBuffering,
	);

	return (
		<BufferingContextReact.Provider value={bufferManager}>
			{children}
		</BufferingContextReact.Provider>
	);
};
