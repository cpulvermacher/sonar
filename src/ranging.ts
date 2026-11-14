// Echo ranging for one ping at a time: range profile relative to the direct
// path, the phone's own clutter learned as a floor under it, and the echo
// picked from what rises above that floor.
//
// The sound reaching the mic directly from the speaker is not one clean
// pulse: on a phone it is a cluster of arrivals about 1 ms wide, followed by
// a tail (ringing, the case, the hand) that decays over another 1–2 ms. An
// echo from a wall 20–50 cm away is only about 10 dB above that tail, so the
// tail has to be known. It is learned as the lowest level ever seen at each
// lag: whatever the phone is pointed at comes and goes, the phone's own
// response is always there.

import { chirpBand, type SonarConfig } from './config';
import { argmax, MatchedFilter, median, nextPow2, speedOfSound } from './dsp';
import { type Motion, type MotionOptions, MotionTracker } from './motion';

export interface RangingParams {
    /** Metres of one-way distance per sample of round-trip delay. */
    metresPerSample: number;
    /** Added to measured distances, see SonarConfig.rangeOffset. */
    rangeOffset: number;
    /** The direct path's position is the power centroid this far around its maximum. */
    centroidHalf: number;
    /** Extent of the direct cluster around its centroid, whose energy is the reference level. */
    clusterBefore: number;
    clusterAfter: number;
    /** The reference level is the cluster energy divided by this. */
    clusterNorm: number;
    /** Half-width of the boxcar the power is smoothed with. */
    smooth: number;
    /** Lags (after the direct path) searched for echoes: [minLag, maxLag]. */
    minLag: number;
    maxLag: number;
    /** Narrower stretches above the threshold are ignored. */
    minWidth: number;
    /** Minimum power excess over the clutter floor. */
    minExcess: number;
    /** Minimum echo power at 0.5 m; scales with 1/distance². */
    sensitivity: number;
    /**
     * A nearer echo may be less clear than one behind it by this power
     * ratio, see chooseEcho. Infinity: the nearest is always reported.
     */
    nearPreference: number;
    /** Power ratio by which a moving echo counts as clearer; 0: motion is not used. */
    motionBonus: number;
    floor: FloorOptions;
    motion: MotionOptions;
}

export interface FloorOptions {
    /** The threshold at a lag covers the floor this many lags to either side. */
    dilate: number;
    /** Power ratio (> 1) by which the floor creeps up per ping. */
    leak: number;
    /** Largest power ratio (> 1) by which the floor drops per ping. */
    maxDrop: number;
}

const fromDb = (db: number) => 10 ** (db / 10);

export function rangingParams(
    sampleRate: number,
    config: SonarConfig
): RangingParams {
    const samples = (seconds: number) =>
        Math.max(1, Math.round(seconds * sampleRate));
    const pings = (seconds: number) =>
        Math.max(2, Math.round(seconds / config.interval));
    const metresPerSample = speedOfSound(config.temperature) / sampleRate / 2;
    const balanced = config.echoChoice === 'balanced';
    return {
        metresPerSample,
        rangeOffset: config.rangeOffset,
        centroidHalf: samples(0.67e-3),
        clusterBefore: samples(1.04e-3),
        clusterAfter: samples(0.52e-3),
        clusterNorm: samples(0.21e-3),
        smooth: samples(0.1e-3),
        minLag: Math.ceil(config.blindRange / metresPerSample),
        maxLag: Math.ceil(
            (config.maxRange - config.rangeOffset) / metresPerSample
        ),
        minWidth: samples(0.06e-3),
        minExcess: fromDb(config.minExcessDb),
        sensitivity: fromDb(config.sensitivityDb),
        nearPreference: balanced
            ? fromDb(config.nearPreferenceDb)
            : Number.POSITIVE_INFINITY,
        motionBonus: balanced ? fromDb(config.motionBonusDb) : 0,
        motion: {
            // As far as the DistanceTracker follows from ping to ping.
            gate: (0.04 + 1.5 * config.interval) / metresPerSample,
            // Half a second, but four positions at least: fewer do not
            // tell a steady shift from jitter.
            window: Math.max(3, pings(0.5)),
            // More than a hand trembles, or a ragged echo jitters.
            minMove: 0.02 / metresPerSample,
            // Stopping does not make an echo the wrong one.
            hold: pings(2),
            maxGap: pings(0.3),
        },
        floor: {
            // Covers the jitter of the direct path's position.
            dilate: samples(0.05e-3),
            // 3 dB per minute: forgets a floor that has become too low
            // (a different grip) without soon losing an echo that stays put.
            leak: fromDb((3 * config.interval) / 60),
            // 20 dB per second: one odd ping cannot pull the floor down.
            maxDrop: fromDb(Math.max(1, 20 * config.interval)),
        },
    };
}

/** Samples needed before the direct path's maximum and after it. */
export function leadSamples(p: RangingParams): number {
    return p.centroidHalf + p.clusterBefore + p.smooth + 2;
}
export function tailSamples(p: RangingParams): number {
    return p.centroidHalf + p.maxLag + p.smooth + 2;
}

export interface RangeProfile {
    /** Position of the direct path in the recording (fractional samples). */
    direct: number;
    /** The sample that lag 0 of `power` is at: direct, rounded. */
    origin: number;
    /** Reference level: RMS-like amplitude of the direct cluster. */
    amplitude: number;
    /** Smoothed power relative to the direct cluster, for lags 0..maxLag. */
    power: Float32Array;
}

/**
 * Range profile from the matched filter output `pw` (squared envelope) of a
 * recording whose direct path lies in [from, to).
 */
export function rangeProfile(
    pw: Float64Array,
    from: number,
    to: number,
    p: RangingParams
): RangeProfile {
    const at = (i: number) => (i >= 0 && i < pw.length ? pw[i] : 0);
    const m = argmax(pw, Math.max(0, from), Math.min(to, pw.length));

    // The maximum jumps between the cluster's arrivals from ping to ping;
    // the centroid does not.
    let sum = 0;
    let moment = 0;
    for (let i = m - p.centroidHalf; i <= m + p.centroidHalf; i++) {
        sum += at(i);
        moment += at(i) * (i - m);
    }
    const direct = sum > 0 ? m + moment / sum : m;
    const origin = Math.round(direct);

    let energy = 0;
    for (let l = -p.clusterBefore; l <= p.clusterAfter; l++) {
        energy += at(origin + l);
    }
    const reference = Math.max(energy / p.clusterNorm, 1e-30);

    const w = p.smooth;
    const power = new Float32Array(p.maxLag + 1);
    let acc = 0;
    for (let i = -w; i <= w; i++) {
        acc += at(origin + i);
    }
    const scale = 1 / ((2 * w + 1) * reference);
    for (let l = 0; l <= p.maxLag; l++) {
        // (The running sum can end up a rounding error below zero.)
        power[l] = Math.max(0, acc * scale);
        acc += at(origin + l + w + 1) - at(origin + l - w);
    }
    return { direct, origin, amplitude: Math.sqrt(reference), power };
}

/**
 * The lowest power seen at each lag: the phone's own response, plus
 * whatever else never goes away.
 */
export class ClutterFloor {
    private level: Float32Array | null = null;
    private readonly options: FloorOptions;

    constructor(options: FloorOptions) {
        this.options = options;
    }

    get ready(): boolean {
        return this.level !== null;
    }

    update(power: Float32Array): void {
        const level = this.level;
        if (!level) {
            this.level = this.seed(power);
            return;
        }
        const { leak, maxDrop } = this.options;
        for (let l = 0; l < level.length; l++) {
            level[l] = Math.max(
                level[l] / maxDrop,
                Math.min(level[l] * leak, power[l])
            );
        }
    }

    /**
     * Before anything else is known, the phone's response is assumed to
     * decay monotonically: the floor is the running minimum of the first
     * profile, so that anything rising again after a dip already stands out.
     */
    private seed(power: Float32Array): Float32Array {
        const level = new Float32Array(power.length);
        let run = Number.POSITIVE_INFINITY;
        for (let l = 0; l < power.length; l++) {
            run = Math.min(run, power[l]);
            level[l] = run;
        }
        return level;
    }

    /** The floor widened by `dilate` lags and raised by the factor `excess`. */
    threshold(excess: number): Float32Array {
        const level = this.level;
        if (!level) {
            throw new Error('no floor yet');
        }
        const n = level.length;
        const d = this.options.dilate;
        const out = new Float32Array(n);
        for (let l = 0; l < n; l++) {
            let max = 0;
            for (let k = Math.max(0, l - d); k <= Math.min(n - 1, l + d); k++) {
                max = Math.max(max, level[k]);
            }
            out[l] = max * excess;
        }
        return out;
    }
}

export interface Echo {
    /** Lag of the echo in the profile (fractional). */
    lag: number;
    /** Its power relative to the direct cluster. */
    level: number;
    /** How uncertain it is that this is the right one of several echoes. */
    ambiguity: PeakAmbiguity;
}

/**
 * The uncertainty about which echo is the right one. Every other candidate
 * is given odds of being the right one instead; from those follow the
 * probability that the reported echo is right, and the error to expect from
 * having picked the wrong one: the distances to the others, weighted with
 * their probabilities. Lengths are in lags here, and in m in a PingResult.
 */
export interface PeakAmbiguity {
    /** Probability that the reported echo is the right one. */
    confidence: number;
    /** Expected error towards the phone (the right echo is a nearer one). */
    nearer: number;
    /** Expected error away from the phone. */
    farther: number;
    /** Position of the most likely other echo, if there is any. */
    rival: number | null;
}

/**
 * Power an echo needs at each lag: above the clutter threshold, and at least
 * as strong as the weakest echo wanted from that distance.
 */
export function echoThreshold(
    clutter: Float32Array,
    p: RangingParams
): Float32Array {
    const out = new Float32Array(clutter.length);
    for (let l = 0; l < out.length; l++) {
        const r = Math.max(0.05, l * p.metresPerSample + p.rangeOffset);
        out[l] = Math.max(clutter[l], p.sensitivity * (0.5 / r) ** 2);
    }
    return out;
}

/** A stretch of the profile above the threshold: possibly the echo. */
export interface Candidate {
    /** Position of the echo in it (fractional lag) and its power. */
    lag: number;
    level: number;
    /** Largest ratio of power to threshold in it. */
    margin: number;
    /** Whether the threshold there is set by the clutter. */
    inClutter: boolean;
    /** Whether its distance has been changing, see MotionTracker. */
    motion: Motion;
}

/**
 * The candidates for the echo, nearest first: every stretch of the profile
 * above the threshold. How far it rises above the threshold is its margin.
 * Within a stretch, the echo is at the first local maximum that is not just
 * a foothill (at least half the power of the stretch's maximum).
 *
 * @param clutter the clutter part of the threshold, see echoThreshold; by
 *   default all of the threshold counts as clutter
 */
export function findCandidates(
    power: Float32Array,
    threshold: Float32Array,
    p: RangingParams,
    clutter: Float32Array = threshold
): Candidate[] {
    const end = Math.min(p.maxLag, power.length - 1);
    const candidates: Candidate[] = [];
    let l = p.minLag;
    while (l <= end) {
        if (power[l] < threshold[l]) {
            l++;
            continue;
        }
        const start = l;
        let peak = l;
        let margin = 0;
        let inClutter = false;
        while (l <= end && power[l] >= threshold[l]) {
            if (power[l] > power[peak]) {
                peak = l;
            }
            if (power[l] > margin * threshold[l]) {
                margin = power[l] / threshold[l];
                inClutter = clutter[l] >= threshold[l];
            }
            l++;
        }
        if (l - start < p.minWidth) {
            continue;
        }
        let at = peak;
        for (let k = start; k < peak; k++) {
            const isMax =
                power[k] >= power[Math.max(0, k - 1)] &&
                power[k] > power[k + 1];
            if (isMax && power[k] >= 0.5 * power[peak]) {
                at = k;
                break;
            }
        }
        candidates.push({
            lag: refine(power, at),
            level: power[at],
            margin,
            inClutter,
            motion: 'unknown',
        });
    }
    return candidates;
}

/**
 * For the ambiguity only: how much clearer (power ratio) an echo behind the
 * reported one would have to be to count as equally likely, where the
 * choice itself always goes to the nearer one. There is always something
 * behind the nearest thing (the floor, the ceiling), so what is behind is
 * an unlikely answer unless the reported echo is weak.
 */
const FAR_PREFERENCE = 10 ** 1.2;

/**
 * The nearest of the candidates `among` (indices, nearest first), with one
 * exception: where the threshold is set by the clutter (close to the
 * phone), a candidate is passed over if one behind it is more than
 * nearPreference clearer. Something that barely clears the clutter in front
 * of a clear echo is more likely a fluctuation of the phone's own response
 * than the thing being measured.
 *
 * Further out the nearest always wins: there the alternatives are things
 * like the ceiling, which are often clearer than a distant wall and would
 * win too easily.
 */
function nearestClear(
    candidates: Candidate[],
    among: number[],
    p: RangingParams
): number {
    let chosen = -1;
    let behind = 0;
    for (let k = among.length - 1; k >= 0; k--) {
        const c = candidates[among[k]];
        if (!c.inClutter || c.margin * p.nearPreference >= behind) {
            chosen = among[k];
        }
        behind = Math.max(behind, c.margin);
    }
    return chosen;
}

/**
 * For the ambiguity: how much clearer (power ratio) the candidate `other`
 * would have to be to be as good a guess as `c`: by the handicap of being
 * behind it, or the advantage of being in front, and by that of moving
 * when the other does not.
 */
function handicap(c: Candidate, other: Candidate, p: RangingParams): number {
    const nearer = other.lag > c.lag ? c : other;
    const preference = nearer.inClutter
        ? Math.min(p.nearPreference, FAR_PREFERENCE)
        : FAR_PREFERENCE;
    const position = nearer === c ? preference : 1 / preference;
    const motion =
        c.motion === 'moving' && other.motion === 'still'
            ? p.motionBonus
            : c.motion === 'still' && other.motion === 'moving'
              ? 1 / p.motionBonus
              : 1;
    return position * motion;
}

/**
 * The echo to report, a balance between the nearest and the best guess: see
 * nearestClear, which decides unless motion says otherwise. If that
 * candidate is known to stay put while others move, the one that nearestClear picks
 * among the moving ones is reported instead, unless it is less clear by
 * more than motionBonus: what moves is what the phone is being moved
 * against, or what is being moved in front of it.
 *
 * The ambiguity of the choice follows from how narrowly it was made: a
 * candidate that would have been as good a guess had it been clearer by
 * some factor has odds of one in that factor of being the right one after
 * all. For this only, an echo further out counts as a worse guess by
 * FAR_PREFERENCE, where the choice itself always goes to the nearer one.
 */
export function chooseEcho(
    candidates: Candidate[],
    p: RangingParams
): Echo | null {
    const n = candidates.length;
    const all = candidates.map((_, i) => i);
    let chosen = nearestClear(candidates, all, p);
    if (chosen < 0) {
        return null;
    }
    if (p.motionBonus > 0 && candidates[chosen].motion === 'still') {
        const mover = nearestClear(
            candidates,
            all.filter((i) => candidates[i].motion === 'moving'),
            p
        );
        // (One in front was passed over in the clutter, and still has the
        // benefit of being nearer.)
        const benefit = p.motionBonus * (mover < chosen ? p.nearPreference : 1);
        if (
            mover >= 0 &&
            candidates[mover].margin * benefit >= candidates[chosen].margin
        ) {
            chosen = mover;
        }
    }

    const c = candidates[chosen];
    let total = 1;
    let nearer = 0;
    let farther = 0;
    let rival: number | null = null;
    let rivalOdds = 0;
    for (let i = 0; i < n; i++) {
        if (i === chosen) {
            continue;
        }
        const other = candidates[i];
        const odds = Math.min(
            1,
            other.margin / (c.margin * handicap(c, other, p))
        );
        total += odds;
        if (i < chosen) {
            nearer += odds * (c.lag - other.lag);
        } else {
            farther += odds * (other.lag - c.lag);
        }
        if (odds > rivalOdds) {
            rivalOdds = odds;
            rival = other.lag;
        }
    }
    return {
        lag: c.lag,
        level: c.level,
        ambiguity: {
            confidence: 1 / total,
            nearer: nearer / total,
            farther: farther / total,
            rival,
        },
    };
}

/** The echo in one profile on its own, see findCandidates and chooseEcho. */
export function findEcho(
    power: Float32Array,
    threshold: Float32Array,
    p: RangingParams,
    clutter: Float32Array = threshold
): Echo | null {
    return chooseEcho(findCandidates(power, threshold, p, clutter), p);
}

/** Vertex of the parabola through power[k-1..k+1], in dB. */
function refine(power: Float32Array, k: number): number {
    if (k <= 0 || k >= power.length - 1) {
        return k;
    }
    const a = Math.log(Math.max(power[k - 1], 1e-30));
    const b = Math.log(Math.max(power[k], 1e-30));
    const c = Math.log(Math.max(power[k + 1], 1e-30));
    const denom = a - 2 * b + c;
    if (denom >= 0) {
        return k;
    }
    return k + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
}

export interface PingResult {
    /**
     * False if the direct path was not found, e.g. while nothing has been
     * played yet or when the audio stream glitched during the ping; the
     * other fields are then not meaningful.
     */
    valid: boolean;
    /** Position of the direct path in the recording (fractional samples). */
    direct: number;
    /** Amplitude of the direct path, in matched-filter units. */
    amplitude: number;
    /** Smoothed power relative to the direct path, per lag after it. */
    power: Float32Array;
    /** Power an echo needs at each lag (empty if not valid). */
    threshold: Float32Array;
    /** Lag of power[0] relative to the direct path, in samples (|…| ≤ 0.5). */
    lagOffset: number;
    echo: Echo | null;
    /** Distance of the echo in m, including the range offset. */
    distance: number | null;
    /** The echo's ambiguity, with lengths in m and the rival as a distance. */
    ambiguity: PeakAmbiguity | null;
}

/** Direct path amplitudes remembered for the plausibility check. */
const AMPLITUDE_HISTORY = 9;
/** A direct path weaker than this fraction of the recent median is a glitch. */
const MIN_AMPLITUDE_RATIO = 0.7;
/** While searching: minimum ratio of the direct path's power to the median power. */
const MIN_ACQUIRE_RATIO = 100;
/** Highpass cutoff relative to the lower chirp frequency. */
const HIGHPASS_RATIO = 0.7;

/** Processes the recordings of consecutive pings. */
export class Ranger {
    readonly params: RangingParams;
    private readonly chirp: Float32Array;
    /** Matched filters by FFT size. */
    private readonly filters = new Map<number, MatchedFilter>();
    private readonly floor: ClutterFloor;
    private readonly motion: MotionTracker;
    /** Highpass cutoff in cycles per sample. */
    private readonly highpass: number;
    private amplitudes: number[] = [];

    constructor(chirp: Float32Array, sampleRate: number, config: SonarConfig) {
        this.params = rangingParams(sampleRate, config);
        this.chirp = chirp;
        this.floor = new ClutterFloor(this.params.floor);
        this.motion = new MotionTracker(this.params.motion);
        this.highpass = (HIGHPASS_RATIO * chirpBand(config).f0) / sampleRate;
    }

    private filterFor(length: number): MatchedFilter {
        const n = nextPow2(length + this.chirp.length);
        let filter = this.filters.get(n);
        if (!filter) {
            filter = new MatchedFilter(this.chirp, length, this.highpass);
            this.filters.set(n, filter);
        }
        return filter;
    }

    /**
     * Analyses the recording x of one ping, whose direct path arrives in
     * [from, to). x should extend leadSamples() before `from` and
     * tailSamples() plus the chirp length after `to`.
     *
     * @param acquiring the direct path may be missing altogether (its
     *   position is not known yet): it must stand out of the noise, and
     *   what is known about its amplitude is forgotten
     */
    process(
        x: Float32Array,
        from: number,
        to: number,
        acquiring = false
    ): PingResult {
        const p = this.params;
        const pw = this.filterFor(x.length).power(x);
        const profile = rangeProfile(pw, from, to, p);
        const result: PingResult = {
            valid: false,
            direct: profile.direct,
            amplitude: profile.amplitude,
            power: profile.power,
            threshold: new Float32Array(0),
            lagOffset: profile.origin - profile.direct,
            echo: null,
            distance: null,
            ambiguity: null,
        };
        const toMetres = (lag: number) =>
            (lag + result.lagOffset) * p.metresPerSample + p.rangeOffset;

        if (acquiring) {
            const peak = pw[Math.round(profile.direct)] ?? 0;
            // (Not ">=": digital silence must not pass.)
            if (!(peak > MIN_ACQUIRE_RATIO * median(pw.subarray(from, to)))) {
                return result;
            }
            this.amplitudes = [];
        } else if (
            this.amplitudes.length >= 3 &&
            profile.amplitude < MIN_AMPLITUDE_RATIO * median(this.amplitudes)
        ) {
            this.motion.skip();
            return result;
        }
        this.amplitudes.push(profile.amplitude);
        if (this.amplitudes.length > AMPLITUDE_HISTORY) {
            this.amplitudes.shift();
        }
        result.valid = true;

        if (!this.floor.ready) {
            this.floor.update(profile.power);
        }
        const clutter = this.floor.threshold(p.minExcess);
        result.threshold = echoThreshold(clutter, p);
        const candidates = findCandidates(
            profile.power,
            result.threshold,
            p,
            clutter
        );
        if (p.motionBonus > 0) {
            const motion = this.motion.update(
                candidates.map((c) => c.lag + result.lagOffset)
            );
            candidates.forEach((c, i) => {
                c.motion = motion[i];
            });
        }
        result.echo = chooseEcho(candidates, p);
        this.floor.update(profile.power);
        if (result.echo) {
            const { lag, ambiguity } = result.echo;
            result.distance = toMetres(lag);
            result.ambiguity = {
                confidence: ambiguity.confidence,
                nearer: ambiguity.nearer * p.metresPerSample,
                farther: ambiguity.farther * p.metresPerSample,
                rival:
                    ambiguity.rival === null ? null : toMetres(ambiguity.rival),
            };
        }
        return result;
    }
}
