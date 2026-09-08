import {useContext, useMemo} from 'react';
import {
	BufferingContextReact,
	type BufferBlockMetadata,
	type BufferingDiagnostics,
} from './buffering';
import {Log} from './log';
import {useLogLevel} from './log-level-context';

export type DelayPlaybackHandle = {
	unblock: (reason?: string) => void;
};

export type UseBufferState = {
	delayPlayback: (metadata?: BufferBlockMetadata) => DelayPlaybackHandle;
	getBufferingDiagnostics?: () => BufferingDiagnostics | null;
};

export const useBufferState = (): UseBufferState => {
	const buffer = useContext(BufferingContextReact);
	const logLevel = useLogLevel();

	// Allows <Img> tag to be rendered without a context
	// https://github.com/remotion-dev/remotion/issues/4007
	const addBlock = buffer ? buffer.addBlock : null;
	const getBufferingDiagnostics = buffer
		? buffer.getBufferingDiagnostics
		: null;

	return useMemo(
		() => ({
			delayPlayback: (metadata) => {
				if (!addBlock) {
					throw new Error(
						'Tried to enable the buffering state, but a Remotion context was not found. This API can only be called in a component that was passed to the Remotion Player or a <Composition>. Or you might have experienced a version mismatch - run `npx remotion versions` and ensure all packages have the same version. This error is thrown by the buffer state https://remotion.dev/docs/player/buffer-state',
					);
				}

				const callStack = new Error().stack ?? null;
				const resolvedMetadata =
					metadata && Object.keys(metadata).length > 0
						? metadata
						: {
								label: 'unattributed-delay-playback',
								source: 'useBufferState',
								reason: 'metadata-not-provided',
								stack: callStack,
							};

				Log.trace(
					{logLevel, tag: '[buffer-state]'},
					'Adding buffer handle',
					resolvedMetadata,
					callStack,
				);

				const {unblock} = addBlock(resolvedMetadata);

				let unblocked = false;

				return {
					unblock: (reason) => {
						if (unblocked) {
							return;
						}

						unblocked = true;
						Log.trace(
							{logLevel, tag: '[buffer-state]'},
							'Removing buffer handle',
							reason,
						);
						unblock(reason);
					},
				};
			},
			getBufferingDiagnostics: () => getBufferingDiagnostics?.() ?? null,
		}),
		[addBlock, getBufferingDiagnostics, logLevel],
	);
};
