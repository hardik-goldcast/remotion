import type {BufferBlockMetadata} from 'remotion';

export type DelayPlaybackMetadata = BufferBlockMetadata;

export type DelayPlaybackIfNotPremounting = {
	unblock: (reason?: string) => void;
	[Symbol.dispose]: () => void;
};
