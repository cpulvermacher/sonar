// Turns per-ping distance measurements into a steady reading that still
// follows quickly: measurements close to the current track are smoothed
// (lightly when they move, more when they only jitter), a jump is followed
// once a second ping confirms it, and single outliers are ignored.

import type { PeakAmbiguity } from './ranging';

const UNAMBIGUOUS: PeakAmbiguity = {
    confidence: 1,
    nearer: 0,
    farther: 0,
    rival: null,
};

export interface Estimate {
    /** Tracked distance in m. */
    distance: number;
    /** Total standard deviation, in m. */
    sigma: number;
    /** Components of sigma: scatter between pings, speed of sound. */
    sigmaStat: number;
    sigmaSound: number;
    /**
     * A second, separate uncertainty: sigma assumes that the right echo is
     * being followed, this is about whether it is. Averaged over the recent
     * pings; a ping that reported some other distance counts as a wrong
     * pick at that distance.
     */
    peak: PeakAmbiguity;
}

export interface TrackerOptions {
    /** Time between pings in s. */
    interval: number;
    /** Relative uncertainty of the speed of sound. */
    soundSpeedRelError: number;
    /** Fastest change in distance that is followed without re-confirmation, m/s. */
    maxSpeed?: number;
}

/** Jitter below this (m) is smoothed heavily, movement beyond it is followed. */
const JITTER = 0.01;
const MIN_ALPHA = 0.25;
const MAX_ALPHA = 0.8;
/** A measurement this far (m) from the track is still the same target, at any ping rate. */
const BASE_GATE = 0.04;
/** Pings that must agree before the track jumps to a new distance. */
const CONFIRM = 2;
/** The track is dropped after this long (s) without a matching measurement. */
const HOLD_SECONDS = 0.3;
/** Smoothing factor of the scatter estimate. */
const SCATTER_ALPHA = 0.2;
/** The peak ambiguity is averaged over about this long (s). */
const AMBIGUITY_SECONDS = 0.25;

export class DistanceTracker {
    private readonly options: TrackerOptions;
    private readonly gate: number;
    private readonly maxMisses: number;
    private track: number | null = null;
    private misses = 0;
    /** Recent measurements that do not fit the track but agree with each other. */
    private pending: number[] = [];
    /** Running mean square of the measurements' deviation from the updated track. */
    private scatter = 0;
    private peak = UNAMBIGUOUS;
    private readonly peakAlpha: number;

    constructor(options: TrackerOptions) {
        this.options = options;
        this.peakAlpha = 1 - Math.exp(-options.interval / AMBIGUITY_SECONDS);
        this.gate = BASE_GATE + (options.maxSpeed ?? 1.5) * options.interval;
        this.maxMisses = Math.max(
            2,
            Math.round(HOLD_SECONDS / options.interval)
        );
    }

    reset(): void {
        this.track = null;
        this.misses = 0;
        this.pending = [];
        this.scatter = 0;
        this.peak = UNAMBIGUOUS;
    }

    /** Moves the averaged peak ambiguity towards that of one ping. */
    private blendPeak(ping: PeakAmbiguity): void {
        const a = this.peakAlpha;
        const mix = (old: number, now: number) => old + a * (now - old);
        this.peak = {
            confidence: mix(this.peak.confidence, ping.confidence),
            nearer: mix(this.peak.nearer, ping.nearer),
            farther: mix(this.peak.farther, ping.farther),
            rival: ping.rival,
        };
    }

    /**
     * Takes the measurement of one ping (null: no echo) and returns the new
     * estimate.
     *
     * @param ambiguity how sure the ping is of having picked the right echo
     */
    push(
        distance: number | null,
        ambiguity: PeakAmbiguity = UNAMBIGUOUS
    ): Estimate | null {
        if (distance === null) {
            this.miss();
        } else if (
            this.track !== null &&
            Math.abs(distance - this.track) <= this.gate
        ) {
            const error = distance - this.track;
            const alpha = Math.max(
                MIN_ALPHA,
                Math.min(MAX_ALPHA, Math.abs(error) / (2 * JITTER))
            );
            this.track += alpha * error;
            // What is left after following: jitter, not movement.
            const rest = (1 - alpha) * error;
            this.scatter += SCATTER_ALPHA * (rest * rest - this.scatter);
            this.misses = 0;
            this.pending = [];
            this.blendPeak(ambiguity);
        } else {
            this.pending = this.pending.filter(
                (d) => Math.abs(d - distance) <= this.gate
            );
            this.pending.push(distance);
            if (this.pending.length >= CONFIRM) {
                this.track =
                    this.pending.reduce((a, b) => a + b, 0) /
                    this.pending.length;
                this.scatter = 0;
                this.misses = 0;
                this.pending = [];
                this.peak = ambiguity;
            } else {
                if (this.track !== null) {
                    // Either this ping or the track has the wrong echo.
                    const off = distance - this.track;
                    this.blendPeak({
                        confidence: 0,
                        nearer: Math.max(0, -off),
                        farther: Math.max(0, off),
                        rival: distance,
                    });
                }
                this.miss();
            }
        }
        return this.estimate();
    }

    private miss(): void {
        this.misses++;
        if (this.misses > this.maxMisses) {
            this.track = null;
        }
    }

    estimate(): Estimate | null {
        if (this.track === null) {
            return null;
        }
        const sigmaStat = Math.sqrt(this.scatter);
        const sigmaSound = this.track * this.options.soundSpeedRelError;
        return {
            distance: this.track,
            sigma: Math.hypot(sigmaStat, sigmaSound),
            sigmaStat,
            sigmaSound,
            peak: this.peak,
        };
    }
}
