/**
 * The grouped feed scheduler is deliberately configured in one place. These
 * values are also exposed through the AudioScheduler props so an integration
 * can tune them without changing the scheduling algorithm.
 */
export type AudioFeedSchedulerConfig = Readonly<{
	/** How far the decoder should keep each feed ahead of the playhead. */
	decodeAheadSeconds: number;
	/** How far the decoder may run ahead while buffering is holding playback. */
	bufferingDecodeAheadSeconds: number;
	/** How far ahead a feed may be mounted before its decoder is needed. */
	mountLookaheadSeconds: number;
	/** How much already-played content to retain when mounting feed players. */
	retainBehindSeconds: number;
	/** Coverage required before the scheduler opens its output gate for active feeds. */
	startupBufferSeconds: number;
	/** Enter buffering before a required feed has less than this coverage. */
	lowWatermarkSeconds: number;
	/** Coverage required before audio buffering can be released. */
	recoveryBufferSeconds: number;
	/** How often the scheduler checks decoder and transport health. */
	bufferingCheckIntervalMs: number;
	/** How long low coverage must persist before entering buffering. */
	lowWaterStableMs: number;
	/** How long recovered coverage must persist before resuming. */
	recoveryStableMs: number;
	/**
	 * Allowed A/V transport drift after subtracting AudioContext latency. A
	 * positive value means audio is ahead of the committed video timeline.
	 */
	audioVideoDriftToleranceSeconds: number;
	/** How long sustained A/V drift is retained in diagnostics (it never pauses playback). */
	audioVideoDriftStableMs: number;
}>;

export type AudioFeedSchedulerConfigOverrides =
	Partial<AudioFeedSchedulerConfig>;

/**
 * Defaults for the grouped all-feeds use case.
 *
 * `decodeAheadSeconds` and `startupBufferSeconds` intentionally match the
 * requested rolling window: at composition time `t`, the target is roughly
 * `[t, t + 10]`. `lowWatermarkSeconds` is independent and controls when the
 * shared playback transport stops to let the window refill.
 */
export const DEFAULT_AUDIO_FEED_SCHEDULER_CONFIG: AudioFeedSchedulerConfig =
	Object.freeze({
		decodeAheadSeconds: 10,
		bufferingDecodeAheadSeconds: 11,
		mountLookaheadSeconds: 12,
		retainBehindSeconds: 2,
		startupBufferSeconds: 10,
		lowWatermarkSeconds: 2,
		recoveryBufferSeconds: 10,
		bufferingCheckIntervalMs: 100,
		lowWaterStableMs: 200,
		recoveryStableMs: 250,
		// The normal initial lead is baseLatency + outputLatency. A half-second
		// allowance after that compensates for measurement jitter while still
		// catching the multi-second drift seen in the diagnostic captures.
		audioVideoDriftToleranceSeconds: 0.5,
		audioVideoDriftStableMs: 250,
	});

export const resolveAudioFeedSchedulerConfig = (
	overrides?: AudioFeedSchedulerConfigOverrides,
): AudioFeedSchedulerConfig => {
	return {
		...DEFAULT_AUDIO_FEED_SCHEDULER_CONFIG,
		...overrides,
	};
};
