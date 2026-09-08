import type {AudioBufferSink, WrappedAudioBuffer} from 'mediabunny';

const AUDIO_PRIMING_SECONDS = 0.5;
// AudioBufferSink creates a decoder/seek lifecycle for each buffers() call.
// Keep nearby selected ranges in one decode window so a word-heavy schedule
// does not turn every tiny deletion into another decoder job. The mapper still
// removes the unselected source portions before they reach the audio scheduler.
const AUDIO_SOURCE_RANGE_BATCH_GAP_SECONDS = 0.5;
const AUDIO_SOURCE_RANGE_BATCH_MAX_SPAN_SECONDS = 4;
// When most of a source window is audible, reopening a decoder for every
// source cluster costs more than decoding the gaps. Keep one decoder alive for
// this common feed case. Very sparse/long schedules still use bounded windows.
const AUDIO_SOURCE_RANGE_CONTINUOUS_DECODE_MIN_COVERAGE = 0.5;
const AUDIO_SOURCE_RANGE_CONTINUOUS_DECODE_MAX_SPAN_SECONDS = 5 * 60;

export type AudioBufferSlice = {
	buffer: WrappedAudioBuffer;
	// Position where the audible slice begins on the continuous timeline.
	timelineTimestamp: number;
	// Range to play from the underlying AudioBuffer.
	sourceOffsetInSeconds: number;
	sourceDurationInSeconds: number;
};

export type AudioSourceRange = Readonly<{
	startTimeInSeconds: number;
	endTimeInSeconds: number;
}>;

export async function* makeIteratorWithPriming({
	audioSink,
	timeToSeek,
	maximumTimestamp,
}: {
	audioSink: AudioBufferSink;
	timeToSeek: number;
	maximumTimestamp: number;
}): AsyncGenerator<AudioBufferSlice, void, unknown> {
	const primingStart = Math.max(0, timeToSeek - AUDIO_PRIMING_SECONDS);
	const iterator = audioSink.buffers(primingStart, maximumTimestamp);

	for await (const buffer of iterator) {
		const sourceStart = Math.max(buffer.timestamp, timeToSeek);
		const sourceEnd = Math.min(
			buffer.timestamp + buffer.duration,
			maximumTimestamp,
		);

		if (sourceEnd <= sourceStart) {
			continue;
		}

		yield {
			buffer,
			timelineTimestamp: sourceStart,
			sourceOffsetInSeconds: sourceStart - buffer.timestamp,
			sourceDurationInSeconds: sourceEnd - sourceStart,
		};
	}
}

export async function* makeIteratorOverSourceRanges({
	audioSink,
	timeToSeek,
	maximumTimestamp,
	sourceRanges,
}: {
	audioSink: AudioBufferSink;
	timeToSeek: number;
	maximumTimestamp: number;
	sourceRanges: readonly AudioSourceRange[];
}): AsyncGenerator<AudioBufferSlice, void, unknown> {
	const rangesToDecode: {
		startTimeInSeconds: number;
		endTimeInSeconds: number;
	}[] = [];
	let selectedDuration = 0;
	for (const range of sourceRanges) {
		const rangeStart = Math.max(range.startTimeInSeconds, timeToSeek);
		const rangeEnd = Math.min(range.endTimeInSeconds, maximumTimestamp);

		if (rangeEnd <= rangeStart) {
			continue;
		}
		selectedDuration += rangeEnd - rangeStart;

		const previousRange = rangesToDecode[rangesToDecode.length - 1];
		if (
			previousRange &&
			rangeStart - previousRange.endTimeInSeconds <=
				AUDIO_SOURCE_RANGE_BATCH_GAP_SECONDS &&
			rangeEnd - previousRange.startTimeInSeconds <=
				AUDIO_SOURCE_RANGE_BATCH_MAX_SPAN_SECONDS
		) {
			previousRange.endTimeInSeconds = Math.max(
				previousRange.endTimeInSeconds,
				rangeEnd,
			);
			continue;
		}

		rangesToDecode.push({
			startTimeInSeconds: rangeStart,
			endTimeInSeconds: rangeEnd,
		});
	}

	const firstRange = rangesToDecode[0];
	const lastRange = rangesToDecode[rangesToDecode.length - 1];
	if (firstRange && lastRange) {
		const sourceSpan =
			lastRange.endTimeInSeconds - firstRange.startTimeInSeconds;
		const selectedCoverage = sourceSpan > 0 ? selectedDuration / sourceSpan : 1;

		if (
			sourceSpan <= AUDIO_SOURCE_RANGE_CONTINUOUS_DECODE_MAX_SPAN_SECONDS &&
			selectedCoverage >= AUDIO_SOURCE_RANGE_CONTINUOUS_DECODE_MIN_COVERAGE
		) {
			for await (const slice of makeIteratorWithPriming({
				audioSink,
				timeToSeek: firstRange.startTimeInSeconds,
				maximumTimestamp: lastRange.endTimeInSeconds,
			})) {
				// Yield source-order progress even when this buffer is entirely inside
				// a deleted source gap. The audio iterator updates its high-water mark
				// from every yielded buffer, while the scheduler-side mapper filters
				// the gap before creating an AudioBufferSourceNode. This keeps the
				// global priority queue cooperative across feeds instead of making one
				// feed monopolize it while decoding a long discarded interval.
				yield slice;
			}
			return;
		}
	}

	for (const range of rangesToDecode) {
		for await (const slice of makeIteratorWithPriming({
			audioSink,
			timeToSeek: range.startTimeInSeconds,
			maximumTimestamp: range.endTimeInSeconds,
		})) {
			// A bounded decode window can contain a small source gap. Keep yielding
			// source-order progress and let the scheduler-side mapper remove the
			// unselected portion. This preserves queue fairness for both strategies.
			yield slice;
		}
	}
}

type MakeLoopingIteratorOptions = {
	audioSink: AudioBufferSink;
	seekTimeInSeconds: number;
	loopStartInSeconds: number;
	segmentEndInSeconds: number;
	maximumContinuousTimestamp: number;
};

export async function* makeLoopingIterator({
	audioSink,
	seekTimeInSeconds,
	loopStartInSeconds,
	segmentEndInSeconds,
	maximumContinuousTimestamp,
}: MakeLoopingIteratorOptions): AsyncGenerator<
	AudioBufferSlice,
	void,
	unknown
> {
	if (segmentEndInSeconds <= loopStartInSeconds) {
		throw new Error(
			`Cannot loop audio over an empty range (${loopStartInSeconds} to ${segmentEndInSeconds})`,
		);
	}

	// The first pass starts at the seek position, every following pass replays
	// the full loop segment from its start. Timestamps continue monotonically
	// across passes so that chunks belonging to a later loop iteration can be
	// scheduled ahead of the loop boundary.
	let passStartInSeconds = seekTimeInSeconds;
	let passBaseTimestamp = seekTimeInSeconds;

	while (true) {
		let yieldedInPass = false;
		for await (const item of makeIteratorWithPriming({
			audioSink,
			timeToSeek: passStartInSeconds,
			maximumTimestamp: segmentEndInSeconds,
		})) {
			yieldedInPass = true;
			const timelineTimestamp =
				passBaseTimestamp + (item.timelineTimestamp - passStartInSeconds);
			const sourceDurationInSeconds = Math.min(
				item.sourceDurationInSeconds,
				maximumContinuousTimestamp - timelineTimestamp,
			);

			if (sourceDurationInSeconds <= 0) {
				return;
			}

			yield {
				...item,
				timelineTimestamp,
				sourceDurationInSeconds,
			};

			if (
				timelineTimestamp + sourceDurationInSeconds >=
				maximumContinuousTimestamp
			) {
				return;
			}
		}

		if (!yieldedInPass && passStartInSeconds === loopStartInSeconds) {
			return;
		}

		passBaseTimestamp += segmentEndInSeconds - passStartInSeconds;
		passStartInSeconds = loopStartInSeconds;
	}
}
