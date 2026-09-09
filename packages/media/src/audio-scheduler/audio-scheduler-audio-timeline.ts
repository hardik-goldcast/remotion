import type {AudioTimeline} from '../audio/audio-timeline';
import type {AudioBufferSlice} from '../make-iterator-with-priming';
import type {NormalizedAudioFeedPlan} from './audio-scheduler-types';

const getRangeEnd = ({
	startTimeInSeconds,
	durationInSeconds,
}: {
	startTimeInSeconds: number;
	durationInSeconds: number;
}) => startTimeInSeconds + durationInSeconds;

/**
 * Build the mapping used by a single feed player.
 *
 * The schedule's composition ranges are compact, while sourceStartTimeInSeconds
 * points into the original recording. Source audio is decoded in source order;
 * each decoded buffer is split at selected source boundaries and scheduled at
 * its compact composition position.
 */
export const makeAudioFeedTimeline = (
	plan: NormalizedAudioFeedPlan,
): AudioTimeline => {
	const {ranges} = plan;
	const sourceRanges = ranges
		.map((range) => ({
			range,
			startTimeInSeconds: range.sourceStartTimeInSeconds,
			endTimeInSeconds: getRangeEnd({
				startTimeInSeconds: range.sourceStartTimeInSeconds,
				durationInSeconds: range.durationInSeconds,
			}),
		}))
		.sort((a, b) => {
			if (a.startTimeInSeconds !== b.startTimeInSeconds) {
				return a.startTimeInSeconds - b.startTimeInSeconds;
			}

			return a.range.startTimeInSeconds - b.range.startTimeInSeconds;
		});
	const sourceStartTimeInSeconds = sourceRanges[0]?.startTimeInSeconds ?? 0;
	const sourceEndTimeInSeconds = sourceRanges.reduce(
		(max, sourceRange) => Math.max(max, sourceRange.endTimeInSeconds),
		0,
	);

	const getCompositionTimeForSourceTime = (sourceTimeInSeconds: number) => {
		for (const sourceRange of sourceRanges) {
			const {
				range,
				startTimeInSeconds: sourceStart,
				endTimeInSeconds: sourceEnd,
			} = sourceRange;

			if (sourceTimeInSeconds < sourceStart) {
				// A source gap is intentionally silent. The source-range iterator does
				// not decode this interval, but this mapping also makes the boundary
				// explicit to the priority scheduler.
				return range.startTimeInSeconds;
			}

			if (sourceTimeInSeconds < sourceEnd) {
				return range.startTimeInSeconds + (sourceTimeInSeconds - sourceStart);
			}
		}

		return null;
	};

	const getSourceTimeForCompositionTime = (
		compositionTimeInSeconds: number,
	) => {
		for (const range of ranges) {
			const compositionEnd = getRangeEnd(range);

			if (compositionTimeInSeconds < range.startTimeInSeconds) {
				return range.sourceStartTimeInSeconds;
			}

			if (compositionTimeInSeconds < compositionEnd) {
				return (
					range.sourceStartTimeInSeconds +
					(compositionTimeInSeconds - range.startTimeInSeconds)
				);
			}
		}

		return sourceEndTimeInSeconds;
	};

	const mapAudioBufferSlice = (slice: AudioBufferSlice) => {
		const sliceStart = slice.timelineTimestamp;
		const sliceEnd = sliceStart + slice.sourceDurationInSeconds;
		const mappedSlices: AudioBufferSlice[] = [];

		for (const sourceRange of sourceRanges) {
			const {startTimeInSeconds: rangeStart, endTimeInSeconds: rangeEnd} =
				sourceRange;
			const overlapStart = Math.max(sliceStart, rangeStart);
			const overlapEnd = Math.min(sliceEnd, rangeEnd);

			if (overlapEnd <= overlapStart) {
				continue;
			}

			mappedSlices.push({
				buffer: slice.buffer,
				timelineTimestamp: overlapStart,
				sourceOffsetInSeconds:
					slice.sourceOffsetInSeconds + (overlapStart - sliceStart),
				sourceDurationInSeconds: overlapEnd - overlapStart,
			});
		}

		return mappedSlices;
	};

	return Object.freeze({
		compositionDurationInSeconds: plan.durationInSeconds,
		sourceStartTimeInSeconds,
		sourceEndTimeInSeconds,
		sourceRanges: Object.freeze(
			sourceRanges.map(({startTimeInSeconds, endTimeInSeconds}) =>
				Object.freeze({startTimeInSeconds, endTimeInSeconds}),
			),
		),
		getCompositionTimeForSourceTime,
		getSourceTimeForCompositionTime,
		mapAudioBufferSlice,
	});
};
