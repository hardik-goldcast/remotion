export type AudioSchedulerSource =
	| string
	| {
			readonly render: string;
			readonly preview?: string;
	  };

export type AudioScheduleEntry = {
	readonly id: string;
	readonly src: AudioSchedulerSource;
	readonly startTimeInSeconds: number;
	readonly durationInSeconds: number;
	readonly sourceStartTimeInSeconds: number;
	readonly volume?: number;
	readonly fadeInDurationInSeconds?: number;
	readonly fadeOutDurationInSeconds?: number;
};

export type AudioFeedRange = {
	readonly id: string;
	readonly startTimeInSeconds: number;
	readonly durationInSeconds: number;
	readonly sourceStartTimeInSeconds: number;
	readonly volume?: number;
	readonly fadeInDurationInSeconds?: number;
	readonly fadeOutDurationInSeconds?: number;
};

export type AudioFeedPlan = {
	readonly trackId: string;
	readonly src: AudioSchedulerSource;
	readonly ranges: readonly AudioFeedRange[];
};

export type AudioSchedulerProps =
	| {
			/** The legacy one-player-per-range input. */
			readonly schedule: readonly AudioScheduleEntry[];
			readonly plans?: never;
			readonly config?: never;
	  }
	| {
			/** The grouped one-player-per-feed input. */
			readonly plans: readonly AudioFeedPlan[];
			readonly schedule?: never;
			/** Optional tuning for the grouped rolling scheduler. */
			readonly config?: import('./audio-feed-scheduler-config').AudioFeedSchedulerConfigOverrides;
	  };

export type NormalizedAudioScheduleEntry = Readonly<{
	id: string;
	renderSrc: string;
	previewSrc: string;
	startTimeInSeconds: number;
	durationInSeconds: number;
	sourceStartTimeInSeconds: number;
	volume: number;
	fadeInDurationInSeconds: number;
	fadeOutDurationInSeconds: number;
	originalIndex: number;
}>;

export type NormalizedAudioSchedule = readonly NormalizedAudioScheduleEntry[];

export type NormalizedAudioFeedRange = Readonly<{
	id: string;
	startTimeInSeconds: number;
	durationInSeconds: number;
	sourceStartTimeInSeconds: number;
	volume: number;
	fadeInDurationInSeconds: number;
	fadeOutDurationInSeconds: number;
	originalIndex: number;
}>;

export type NormalizedAudioFeedPlan = Readonly<{
	trackId: string;
	renderSrc: string;
	previewSrc: string;
	ranges: readonly NormalizedAudioFeedRange[];
	durationInSeconds: number;
}>;

export type NormalizedAudioFeedPlans = readonly NormalizedAudioFeedPlan[];
