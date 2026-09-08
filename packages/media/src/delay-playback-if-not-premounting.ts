import type {BufferBlockMetadata} from 'remotion';

export type DelayPlaybackMetadata = BufferBlockMetadata;

export type DelayPlaybackIfNotPremounting = {
	unblock: () => void;
	[Symbol.dispose]: () => void;
};
