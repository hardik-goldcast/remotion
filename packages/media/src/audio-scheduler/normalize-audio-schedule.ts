import type {
	AudioFeedPlan,
	AudioFeedRange,
	AudioScheduleEntry,
	NormalizedAudioFeedPlan,
	NormalizedAudioFeedPlans,
	NormalizedAudioFeedRange,
	NormalizedAudioSchedule,
	NormalizedAudioScheduleEntry,
} from './audio-scheduler-types';

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

function assertFiniteNumber(
	entryIndex: number,
	field: string,
	value: unknown,
	subject = `schedule entry ${entryIndex}`,
): asserts value is number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new TypeError(
			`AudioScheduler ${subject} must have a finite ${field}.`,
		);
	}
}

function assertNonNegativeNumber(
	entryIndex: number,
	field: string,
	value: unknown,
	subject = `schedule entry ${entryIndex}`,
): asserts value is number {
	assertFiniteNumber(entryIndex, field, value, subject);
	if (value < 0) {
		throw new RangeError(
			`AudioScheduler ${subject} must have a non-negative ${field}.`,
		);
	}
}

const resolveSource = ({
	entryIndex,
	src,
	subject = `schedule entry ${entryIndex}`,
}: {
	entryIndex: number;
	src: unknown;
	subject?: string;
}): {renderSrc: string; previewSrc: string} => {
	if (typeof src === 'string') {
		if (src.length === 0) {
			throw new TypeError(
				`AudioScheduler ${subject} must have a non-empty src.`,
			);
		}

		return {renderSrc: src, previewSrc: src};
	}

	if (!isRecord(src)) {
		throw new TypeError(
			`AudioScheduler ${subject} must have a string src or a source object with a render string.`,
		);
	}

	const renderSrc = src.render;
	if (typeof renderSrc !== 'string' || renderSrc.length === 0) {
		throw new TypeError(
			`AudioScheduler ${subject} must have a non-empty render src.`,
		);
	}

	const previewSrc = src.preview;
	if (
		previewSrc !== undefined &&
		(typeof previewSrc !== 'string' || previewSrc.length === 0)
	) {
		throw new TypeError(
			`AudioScheduler ${subject} must have a non-empty preview src when provided.`,
		);
	}

	return {renderSrc, previewSrc: previewSrc ?? renderSrc};
};

const normalizeEntry = (
	entry: AudioScheduleEntry,
	entryIndex: number,
): NormalizedAudioScheduleEntry => {
	if (!isRecord(entry)) {
		throw new TypeError(
			`AudioScheduler schedule entry ${entryIndex} must be an object.`,
		);
	}

	const {id} = entry;
	if (typeof id !== 'string' || id.trim().length === 0) {
		throw new TypeError(
			`AudioScheduler schedule entry ${entryIndex} must have a non-empty id.`,
		);
	}

	const {startTimeInSeconds} = entry;
	assertNonNegativeNumber(entryIndex, 'startTimeInSeconds', startTimeInSeconds);

	const {durationInSeconds} = entry;
	assertFiniteNumber(entryIndex, 'durationInSeconds', durationInSeconds);
	if (durationInSeconds <= 0) {
		throw new RangeError(
			`AudioScheduler schedule entry ${entryIndex} must have a durationInSeconds greater than zero.`,
		);
	}

	const {sourceStartTimeInSeconds} = entry;
	assertNonNegativeNumber(
		entryIndex,
		'sourceStartTimeInSeconds',
		sourceStartTimeInSeconds,
	);

	const volume = entry.volume ?? 1;
	assertFiniteNumber(entryIndex, 'volume', volume);
	if (volume < 0 || volume > 1) {
		throw new RangeError(
			`AudioScheduler schedule entry ${entryIndex} must have a volume between 0 and 1.`,
		);
	}

	const fadeInDurationInSeconds = entry.fadeInDurationInSeconds ?? 0;
	assertNonNegativeNumber(
		entryIndex,
		'fadeInDurationInSeconds',
		fadeInDurationInSeconds,
	);

	const fadeOutDurationInSeconds = entry.fadeOutDurationInSeconds ?? 0;
	assertNonNegativeNumber(
		entryIndex,
		'fadeOutDurationInSeconds',
		fadeOutDurationInSeconds,
	);

	const {renderSrc, previewSrc} = resolveSource({
		entryIndex,
		src: entry.src,
	});

	return Object.freeze({
		id,
		renderSrc,
		previewSrc,
		startTimeInSeconds,
		durationInSeconds,
		sourceStartTimeInSeconds,
		volume,
		fadeInDurationInSeconds: Math.min(
			fadeInDurationInSeconds,
			durationInSeconds,
		),
		fadeOutDurationInSeconds: Math.min(
			fadeOutDurationInSeconds,
			durationInSeconds,
		),
		originalIndex: entryIndex,
	});
};

export const normalizeAudioSchedule = (
	schedule: readonly AudioScheduleEntry[],
): NormalizedAudioSchedule => {
	if (!Array.isArray(schedule)) {
		throw new TypeError('AudioScheduler schedule must be an array.');
	}

	const ids = new Set<string>();
	const normalized = schedule.map((entry, entryIndex) => {
		const normalizedEntry = normalizeEntry(entry, entryIndex);
		if (ids.has(normalizedEntry.id)) {
			throw new Error(
				`AudioScheduler schedule contains duplicate id "${normalizedEntry.id}".`,
			);
		}

		ids.add(normalizedEntry.id);
		return normalizedEntry;
	});

	return Object.freeze(normalized);
};

const normalizeFeedRange = (
	range: AudioFeedRange,
	planIndex: number,
	rangeIndex: number,
): NormalizedAudioFeedRange => {
	const subject = `plan ${planIndex} range ${rangeIndex}`;
	if (!isRecord(range)) {
		throw new TypeError(`AudioScheduler ${subject} must be an object.`);
	}

	const {id} = range;
	if (typeof id !== 'string' || id.trim().length === 0) {
		throw new TypeError(`AudioScheduler ${subject} must have a non-empty id.`);
	}

	const {startTimeInSeconds} = range;
	assertNonNegativeNumber(
		rangeIndex,
		'startTimeInSeconds',
		startTimeInSeconds,
		subject,
	);

	const {durationInSeconds} = range;
	assertFiniteNumber(
		rangeIndex,
		'durationInSeconds',
		durationInSeconds,
		subject,
	);
	if (durationInSeconds <= 0) {
		throw new RangeError(
			`AudioScheduler ${subject} must have a durationInSeconds greater than zero.`,
		);
	}

	const {sourceStartTimeInSeconds} = range;
	assertNonNegativeNumber(
		rangeIndex,
		'sourceStartTimeInSeconds',
		sourceStartTimeInSeconds,
		subject,
	);

	const volume = range.volume ?? 1;
	assertFiniteNumber(rangeIndex, 'volume', volume, subject);
	if (volume < 0 || volume > 1) {
		throw new RangeError(
			`AudioScheduler ${subject} must have a volume between 0 and 1.`,
		);
	}

	const fadeInDurationInSeconds = range.fadeInDurationInSeconds ?? 0;
	assertNonNegativeNumber(
		rangeIndex,
		'fadeInDurationInSeconds',
		fadeInDurationInSeconds,
		subject,
	);

	const fadeOutDurationInSeconds = range.fadeOutDurationInSeconds ?? 0;
	assertNonNegativeNumber(
		rangeIndex,
		'fadeOutDurationInSeconds',
		fadeOutDurationInSeconds,
		subject,
	);

	return Object.freeze({
		id,
		startTimeInSeconds,
		durationInSeconds,
		sourceStartTimeInSeconds,
		volume,
		fadeInDurationInSeconds: Math.min(
			fadeInDurationInSeconds,
			durationInSeconds,
		),
		fadeOutDurationInSeconds: Math.min(
			fadeOutDurationInSeconds,
			durationInSeconds,
		),
		originalIndex: rangeIndex,
	});
};

const normalizeFeedPlan = (
	plan: AudioFeedPlan,
	planIndex: number,
): NormalizedAudioFeedPlan => {
	const subject = `plan ${planIndex}`;
	if (!isRecord(plan)) {
		throw new TypeError(`AudioScheduler ${subject} must be an object.`);
	}

	const {trackId} = plan;
	if (typeof trackId !== 'string' || trackId.trim().length === 0) {
		throw new TypeError(
			`AudioScheduler ${subject} must have a non-empty trackId.`,
		);
	}

	if (!Array.isArray(plan.ranges)) {
		throw new TypeError(`AudioScheduler ${subject} must have a ranges array.`);
	}

	const ids = new Set<string>();
	const ranges = plan.ranges.map((range, rangeIndex) => {
		const normalizedRange = normalizeFeedRange(range, planIndex, rangeIndex);
		if (ids.has(normalizedRange.id)) {
			throw new Error(
				`AudioScheduler plan ${planIndex} contains duplicate range id "${normalizedRange.id}".`,
			);
		}

		ids.add(normalizedRange.id);
		return normalizedRange;
	});

	const sortedRanges = ranges.slice().sort((a, b) => {
		if (a.startTimeInSeconds !== b.startTimeInSeconds) {
			return a.startTimeInSeconds - b.startTimeInSeconds;
		}

		return a.originalIndex - b.originalIndex;
	});
	const durationInSeconds = sortedRanges.reduce(
		(max, range) =>
			Math.max(max, range.startTimeInSeconds + range.durationInSeconds),
		0,
	);
	const {renderSrc, previewSrc} = resolveSource({
		entryIndex: planIndex,
		src: plan.src,
		subject,
	});

	return Object.freeze({
		trackId,
		renderSrc,
		previewSrc,
		ranges: Object.freeze(sortedRanges),
		durationInSeconds,
	});
};

export const normalizeAudioFeedPlans = (
	plans: readonly AudioFeedPlan[],
): NormalizedAudioFeedPlans => {
	if (!Array.isArray(plans)) {
		throw new TypeError('AudioScheduler plans must be an array.');
	}

	const trackIds = new Set<string>();
	const normalized = plans.map((plan, planIndex) => {
		const normalizedPlan = normalizeFeedPlan(plan, planIndex);
		if (trackIds.has(normalizedPlan.trackId)) {
			throw new Error(
				`AudioScheduler plans contains duplicate trackId "${normalizedPlan.trackId}".`,
			);
		}

		trackIds.add(normalizedPlan.trackId);
		return normalizedPlan;
	});

	return Object.freeze(normalized);
};

export const flattenNormalizedAudioFeedPlans = (
	plans: NormalizedAudioFeedPlans,
): NormalizedAudioSchedule => {
	let originalIndex = 0;
	const entries = plans.flatMap((plan) =>
		plan.ranges.map((range) =>
			Object.freeze({
				id: `${plan.trackId}:${range.id}`,
				renderSrc: plan.renderSrc,
				previewSrc: plan.previewSrc,
				startTimeInSeconds: range.startTimeInSeconds,
				durationInSeconds: range.durationInSeconds,
				sourceStartTimeInSeconds: range.sourceStartTimeInSeconds,
				volume: range.volume,
				fadeInDurationInSeconds: range.fadeInDurationInSeconds,
				fadeOutDurationInSeconds: range.fadeOutDurationInSeconds,
				originalIndex: originalIndex++,
			}),
		),
	);

	return Object.freeze(entries);
};
