// Decides which stretch of the mic stream belongs to each ping, and analyses
// it. The delay between scheduling a chirp and hearing it (output plus input
// latency, 150 ms and more on a phone) is unknown at first, drifts, and
// sometimes jumps; it is tracked from ping to ping, so that a ping can be
// analysed as soon as its echoes are in, instead of a full ping period later.

import type { SonarConfig } from './config';
import {
    leadSamples,
    type PingResult,
    Ranger,
    type RangingParams,
    tailSamples,
} from './ranging';

/** The direct path is looked for this long (s) around where the last one was. */
const TRACK_TOLERANCE = 8e-3;
/** ... but never further than this fraction of the ping period. */
const MAX_TOLERANCE_PERIODS = 0.4;
/** After this many pings in a row without a direct path, search for it afresh. */
const MAX_INVALID = 3;

export interface PingWindow {
    /** Context frame of the first sample needed. */
    start: number;
    length: number;
    /** The direct path is expected in [from, to) of the window. */
    from: number;
    to: number;
    acquiring: boolean;
}

export interface PingAnalysis extends PingResult {
    /** Context frame of the direct path's arrival (fractional), if valid. */
    directFrame: number;
    /**
     * Delay from scheduling to arrival in frames, if known. While the delay
     * is longer than the ping period it is determined on the assumption that
     * the first chirp heard was the first one played.
     */
    latency: number | null;
}

export class PingAnalyser {
    readonly params: RangingParams;
    private readonly ranger: Ranger;
    private readonly period: number;
    private readonly lead: number;
    private readonly tail: number;
    private readonly tolerance: number;
    /** Arrival delay modulo the ping period, in frames; null while searching. */
    private delay: number | null = null;
    /** Whole ping periods to add to `delay` for the latency. */
    private periods: number | null = null;
    private latency: number | null = null;
    private invalid = 0;
    private processed = 0;

    constructor(chirp: Float32Array, sampleRate: number, config: SonarConfig) {
        this.ranger = new Ranger(chirp, sampleRate, config);
        this.params = this.ranger.params;
        this.period = Math.round(config.interval * sampleRate);
        this.lead = leadSamples(this.params);
        this.tail = tailSamples(this.params) + chirp.length;
        this.tolerance = Math.round(
            Math.min(
                TRACK_TOLERANCE * sampleRate,
                MAX_TOLERANCE_PERIODS * this.period
            )
        );
    }

    /** The frames needed to analyse the ping scheduled at emitFrame. */
    window(emitFrame: number): PingWindow {
        if (this.delay === null) {
            // Anywhere within one period: there is one chirp per period.
            return {
                start: emitFrame - this.lead,
                length: this.lead + this.period + this.tail,
                from: this.lead,
                to: this.lead + this.period,
                acquiring: true,
            };
        }
        return {
            start: emitFrame + this.delay - this.tolerance - this.lead,
            length: this.lead + 2 * this.tolerance + 1 + this.tail,
            from: this.lead,
            to: this.lead + 2 * this.tolerance + 1,
            acquiring: false,
        };
    }

    /**
     * Analyses the ping scheduled at emitFrame.
     *
     * @param x the frames of `window`, as returned by window(emitFrame)
     */
    process(
        emitFrame: number,
        window: PingWindow,
        x: Float32Array
    ): PingAnalysis {
        const result = this.ranger.process(
            x,
            window.from,
            window.to,
            window.acquiring
        );
        const directFrame = window.start + result.direct;
        const index = this.processed++;
        if (result.valid) {
            this.invalid = 0;
            this.delay = Math.round(directFrame - emitFrame);
            if (this.periods === null) {
                this.periods = index;
            } else if (window.acquiring && this.latency !== null) {
                // Found again: the latency closest to what it was.
                this.periods = Math.round(
                    (this.latency - this.delay) / this.period
                );
            }
            this.latency = directFrame - emitFrame + this.periods * this.period;
        } else if (++this.invalid >= MAX_INVALID) {
            this.delay = null;
        }
        return { ...result, directFrame, latency: this.latency };
    }
}
