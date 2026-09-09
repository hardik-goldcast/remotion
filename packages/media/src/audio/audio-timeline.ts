import type {AudioBufferSlice} from '../make-iterator-with-priming';

export type AudioTimelineSourceRange = Readonly<{
	startTimeInSeconds: number;
	endTimeInSeconds: number;
}>;

/**
 * Maps a sparse source timeline to a compact composition timeline.
 *
 * MediaPlayer reads the selected source intervals and only the slices returned
 * by mapAudioBufferSlice are scheduled. This lets one player represent many
 * disjoint ranges without reintroducing the source gaps that were removed by
 * the translation layer.
 */
export type AudioTimeline = Readonly<{
	compositionDurationInSeconds: number;
	sourceStartTimeInSeconds: number;
	sourceEndTimeInSeconds: number;
	/** Source intervals that contain audio selected by the composition. */
	sourceRanges: readonly AudioTimelineSourceRange[];
	getCompositionTimeForSourceTime: (
		sourceTimeInSeconds: number,
	) => number | null;
	getSourceTimeForCompositionTime: (compositionTimeInSeconds: number) => number;
	mapAudioBufferSlice: (slice: AudioBufferSlice) => readonly AudioBufferSlice[];
}>;
