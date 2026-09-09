import type {InputAudioTrack} from 'mediabunny';
import {AudioBufferSink} from 'mediabunny';
import {makeIteratorWithPriming} from '../make-iterator-with-priming';
import type {AudioTimeline} from './audio-timeline';

export type PredecodedAudioWindow = Readonly<{
	buffer: AudioBuffer;
	fromCompositionTimeInSeconds: number;
	toCompositionTimeInSeconds: number;
	sourceStartTimeInSeconds: number;
	sourceEndTimeInSeconds: number;
	decodedSourceUntilInSeconds: number;
	decodedBufferCount: number;
	selectedSliceCount: number;
	selectedAudioDurationInSeconds: number;
}>;

type SelectedSlice = Readonly<{
	buffer: AudioBuffer;
	compositionStartInSeconds: number;
	sourceOffsetInSeconds: number;
	sourceDurationInSeconds: number;
}>;

/**
 * Decode a continuous source window and assemble only the selected portions
 * into one compact composition-time AudioBuffer.
 *
 * This is intentionally separate from the live AudioBufferSourceNode iterator:
 * once this promise resolves, the experiment can play from already-decoded PCM
 * and any later decoder/network delay is removed from the equation.
 */
export const predecodeAudioWindow = async ({
	audioTrack,
	audioTimeline,
	fromCompositionTimeInSeconds,
	toCompositionTimeInSeconds,
}: {
	audioTrack: InputAudioTrack;
	audioTimeline: AudioTimeline;
	fromCompositionTimeInSeconds: number;
	toCompositionTimeInSeconds: number;
}): Promise<PredecodedAudioWindow> => {
	const fromComposition = Math.max(
		0,
		Math.min(
			fromCompositionTimeInSeconds,
			audioTimeline.compositionDurationInSeconds,
		),
	);
	const toComposition = Math.max(
		fromComposition,
		Math.min(
			toCompositionTimeInSeconds,
			audioTimeline.compositionDurationInSeconds,
		),
	);

	if (toComposition <= fromComposition) {
		throw new Error(
			`Cannot predecode an empty audio window (${fromComposition} to ${toComposition}).`,
		);
	}

	const sourceStart =
		audioTimeline.getSourceTimeForCompositionTime(fromComposition);
	const sourceEnd =
		audioTimeline.getSourceTimeForCompositionTime(toComposition);
	if (!(sourceEnd > sourceStart)) {
		throw new Error(
			`Could not map composition window ${fromComposition}–${toComposition} to source audio.`,
		);
	}

	const audioSink = new AudioBufferSink(audioTrack);
	const selectedSlices: SelectedSlice[] = [];
	let sampleRate: number | null = null;
	let numberOfChannels: number | null = null;
	let decodedBufferCount = 0;
	let decodedSourceUntil = sourceStart;
	let selectedAudioDuration = 0;

	for await (const slice of makeIteratorWithPriming({
		audioSink,
		timeToSeek: sourceStart,
		maximumTimestamp: sourceEnd,
	})) {
		decodedBufferCount++;
		decodedSourceUntil = Math.max(
			decodedSourceUntil,
			Math.min(sourceEnd, slice.buffer.timestamp + slice.buffer.duration),
		);

		const decodedBuffer = slice.buffer.buffer;
		if (sampleRate === null) {
			sampleRate = decodedBuffer.sampleRate;
			numberOfChannels = decodedBuffer.numberOfChannels;
		} else if (
			decodedBuffer.sampleRate !== sampleRate ||
			decodedBuffer.numberOfChannels !== numberOfChannels
		) {
			throw new Error(
				'Audio format changed while predecoding one window; resampling is required before concatenation.',
			);
		}

		for (const mappedSlice of audioTimeline.mapAudioBufferSlice(slice)) {
			const compositionStart = audioTimeline.getCompositionTimeForSourceTime(
				mappedSlice.timelineTimestamp,
			);
			if (compositionStart === null) {
				continue;
			}

			const compositionEnd =
				compositionStart + mappedSlice.sourceDurationInSeconds;
			const clippedStart = Math.max(fromComposition, compositionStart);
			const clippedEnd = Math.min(toComposition, compositionEnd);
			if (clippedEnd <= clippedStart) {
				continue;
			}

			const sourceOffset =
				mappedSlice.sourceOffsetInSeconds + (clippedStart - compositionStart);
			const sourceDuration = clippedEnd - clippedStart;
			selectedSlices.push({
				buffer: mappedSlice.buffer.buffer,
				compositionStartInSeconds: clippedStart,
				sourceOffsetInSeconds: sourceOffset,
				sourceDurationInSeconds: sourceDuration,
			});
			selectedAudioDuration += sourceDuration;
		}
	}

	if (sampleRate === null || numberOfChannels === null) {
		throw new Error(
			`The audio decoder produced no PCM for composition window ${fromComposition}–${toComposition}.`,
		);
	}

	const output = new AudioBuffer({
		length: Math.max(
			1,
			Math.ceil((toComposition - fromComposition) * sampleRate),
		),
		numberOfChannels,
		sampleRate,
	});

	for (const selectedSlice of selectedSlices) {
		const sourceBuffer = selectedSlice.buffer;
		const sourceStartFrame = Math.max(
			0,
			Math.round(selectedSlice.sourceOffsetInSeconds * sampleRate),
		);
		const destinationStartFrame = Math.max(
			0,
			Math.round(
				(selectedSlice.compositionStartInSeconds - fromComposition) *
					sampleRate,
			),
		);
		const requestedFrames = Math.max(
			0,
			Math.round(selectedSlice.sourceDurationInSeconds * sampleRate),
		);
		const availableSourceFrames = Math.max(
			0,
			sourceBuffer.length - sourceStartFrame,
		);
		const framesToCopy = Math.min(
			requestedFrames,
			availableSourceFrames,
			output.length - destinationStartFrame,
		);

		if (framesToCopy <= 0) {
			continue;
		}

		for (let channel = 0; channel < numberOfChannels; channel++) {
			output.copyToChannel(
				sourceBuffer
					.getChannelData(channel)
					.subarray(sourceStartFrame, sourceStartFrame + framesToCopy),
				channel,
				destinationStartFrame,
			);
		}
	}

	return {
		buffer: output,
		fromCompositionTimeInSeconds: fromComposition,
		toCompositionTimeInSeconds: toComposition,
		sourceStartTimeInSeconds: sourceStart,
		sourceEndTimeInSeconds: sourceEnd,
		decodedSourceUntilInSeconds: decodedSourceUntil,
		decodedBufferCount,
		selectedSliceCount: selectedSlices.length,
		selectedAudioDurationInSeconds: selectedAudioDuration,
	};
};
