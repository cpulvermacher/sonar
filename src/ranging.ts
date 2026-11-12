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
    floor: FloorOptions;
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
    const metresPerSample = speedOfSound(config.temperature) / sampleRate / 2;
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

/**
 * The nearest echo: the first stretch of the profile above the threshold,
 * and in it the first local maximum that is not just a foothill (at least
 * half the power of the stretch's maximum).
 */
export function findEcho(
    power: Float32Array,
    threshold: Float32Array,
    p: RangingParams
): Echo | null {
    const end = Math.min(p.maxLag, power.length - 1);
    let l = p.minLag;
    while (l <= end) {
        if (power[l] < threshold[l]) {
            l++;
            continue;
        }
        const start = l;
        let peak = l;
        while (l <= end && power[l] >= threshold[l]) {
            if (power[l] > power[peak]) {
                peak = l;
            }
            l++;
        }
        if (l - start < p.minWidth) {
            continue;
        }
        for (let k = start; k <= peak; k++) {
            const isMax =
                k === peak ||
                (power[k] >= power[Math.max(0, k - 1)] &&
                    power[k] > power[k + 1]);
            if (isMax && power[k] >= 0.5 * power[peak]) {
                return { lag: refine(power, k), level: power[k] };
            }
        }
    }
    return null;
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
    /** Highpass cutoff in cycles per sample. */
    private readonly highpass: number;
    private amplitudes: number[] = [];

    constructor(chirp: Float32Array, sampleRate: number, config: SonarConfig) {
        this.params = rangingParams(sampleRate, config);
        this.chirp = chirp;
        this.floor = new ClutterFloor(this.params.floor);
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
        };

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
        result.threshold = echoThreshold(this.floor.threshold(p.minExcess), p);
        result.echo = findEcho(profile.power, result.threshold, p);
        this.floor.update(profile.power);
        if (result.echo) {
            result.distance =
                (result.echo.lag + result.lagOffset) * p.metresPerSample +
                p.rangeOffset;
        }
        return result;
    }
}
