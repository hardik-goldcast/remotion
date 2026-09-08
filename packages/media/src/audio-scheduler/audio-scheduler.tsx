import React, {useMemo} from 'react';
import {useRemotionEnvironment} from 'remotion';
import {resolveAudioFeedSchedulerConfig} from './audio-feed-scheduler-config';
import {AudioFeedSchedulerPreview} from './audio-feed-scheduler-preview';
import {AudioPredecodedFeedSchedulerPreview} from './audio-predecoded-feed-scheduler-preview';
import {AudioSchedulerPreview} from './audio-scheduler-preview';
import {AudioSchedulerRender} from './audio-scheduler-render';
import type {AudioSchedulerProps} from './audio-scheduler-types';
import {
	flattenNormalizedAudioFeedPlans,
	normalizeAudioFeedPlans,
	normalizeAudioSchedule,
} from './normalize-audio-schedule';

const PREDECODE_DIAGNOSTIC_TRACK_ID = '303045d2-14c8-406a-b337-12b08236ba6f';

export const AudioScheduler: React.FC<AudioSchedulerProps> = (props) => {
	const environment = useRemotionEnvironment();
	const normalizedSchedule = useMemo(() => {
		return props.schedule === undefined
			? null
			: normalizeAudioSchedule(props.schedule);
	}, [props.schedule]);
	const normalizedPlans = useMemo(() => {
		return props.plans === undefined
			? null
			: normalizeAudioFeedPlans(props.plans);
	}, [props.plans]);
	const schedulerConfig = useMemo(
		() => resolveAudioFeedSchedulerConfig(props.config),
		[props.config],
	);

	if (normalizedPlans) {
		if (environment.isRendering) {
			return (
				<AudioSchedulerRender
					schedule={flattenNormalizedAudioFeedPlans(normalizedPlans)}
				/>
			);
		}

		if (
			normalizedPlans.length === 1 &&
			normalizedPlans[0].trackId === PREDECODE_DIAGNOSTIC_TRACK_ID
		) {
			return <AudioPredecodedFeedSchedulerPreview plans={normalizedPlans} />;
		}

		return (
			<AudioFeedSchedulerPreview
				plans={normalizedPlans}
				config={schedulerConfig}
			/>
		);
	}

	if (!normalizedSchedule) {
		throw new Error('AudioScheduler requires either plans or schedule.');
	}

	if (environment.isRendering) {
		return <AudioSchedulerRender schedule={normalizedSchedule} />;
	}

	return <AudioSchedulerPreview schedule={normalizedSchedule} />;
};
