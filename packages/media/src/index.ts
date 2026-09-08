import {AudioScheduler} from './audio-scheduler/audio-scheduler';
import {Audio} from './audio/audio';
import {Video} from './video/video';
/**
 * @deprecated Now just `Audio`
 */
export const experimental_Audio = Audio;

/**
 * @deprecated Now just `Video`
 */
export const experimental_Video = Video;

export {
	DEFAULT_AUDIO_FEED_SCHEDULER_CONFIG,
	resolveAudioFeedSchedulerConfig,
} from './audio-scheduler/audio-feed-scheduler-config';
export type {
	AudioFeedSchedulerConfig,
	AudioFeedSchedulerConfigOverrides,
} from './audio-scheduler/audio-feed-scheduler-config';
export type {
	AudioFeedPlan,
	AudioFeedRange,
	AudioScheduleEntry,
	AudioSchedulerProps,
	AudioSchedulerSource,
} from './audio-scheduler/audio-scheduler-types';
export {AudioForPreview} from './audio/audio-for-preview';
export type {AudioProps, FallbackHtml5AudioProps} from './audio/props';
export {getTargetSampleRate} from './convert-audiodata/resample-audiodata';
export type {MediaErrorAction} from './on-error';
export type {MediaRequestInit} from './request-init';
export type {
	FallbackOffthreadVideoProps,
	VideoObjectFit,
	VideoProps,
} from './video/props';
export {Audio, AudioScheduler, Video};
