// Combines per-ping distance measurements into a robust estimate with an
// error range.

import { median } from './dsp';

export interface Measurement {
    /** Distance in m, or null if no echo was found. */
    distance: number | null;
    /** Model (SNR-based) standard deviation of this measurement, in m. */
    sigma: number;
    /** Power SNR of the echo peak. */
    snr: number;
}

export interface Estimate {
    /** Median distance of the accepted measurements, in m. */
    distance: number;
    /** Total standard deviation, in m. */
    sigma: number;
    /** Components of sigma: scatter between pings, SNR model, speed of sound. */
    sigmaStat: number;
    sigmaModel: number;
    sigmaSound: number;
    /** Accepted measurements out of the pings in the window. */
    accepted: number;
    window: number;
}

export interface EstimatorOptions {
    /** Number of most recent pings considered. */
    window: number;
    /** Measurements below this echo SNR (dB) are discarded. */
    minSnrDb: number;
    /** Measurements farther than this many robust σ from the median are outliers. */
    outlierSigmas: number;
    /** Minimum accepted measurements for an estimate. */
    minAccepted: number;
    /** Relative uncertainty of the speed of sound. */
    soundSpeedRelError: number;
}

/** σ = 1.4826 · MAD for normally distributed data. */
const MAD_TO_SIGMA = 1.4826;
/** Standard error of the median is ≈ 1.2533 · σ / √n for normal data. */
const MEDIAN_EFFICIENCY = 1.2533;

export class DistanceEstimator {
    private history: Measurement[] = [];

    constructor(private readonly options: EstimatorOptions) {}

    reset(): void {
        this.history = [];
    }

    push(m: Measurement): void {
        this.history.push(m);
        if (this.history.length > this.options.window) {
            this.history.shift();
        }
    }

    estimate(): Estimate | null {
        const o = this.options;
        const minSnr = 10 ** (o.minSnrDb / 10);
        const valid = this.history.filter(
            (m): m is Measurement & { distance: number } =>
                m.distance !== null && m.snr >= minSnr
        );
        if (valid.length < o.minAccepted) {
            return null;
        }

        // Reject outliers relative to the median, using the MAD as robust σ.
        // Never reject within the model σ, so identical values don't make the
        // tolerance collapse to zero.
        const m0 = median(valid.map((m) => m.distance));
        const mad = median(valid.map((m) => Math.abs(m.distance - m0)));
        const modelSigma = median(valid.map((m) => m.sigma));
        const tolerance =
            o.outlierSigmas * Math.max(MAD_TO_SIGMA * mad, modelSigma);
        const kept = valid.filter(
            (m) => Math.abs(m.distance - m0) <= tolerance
        );
        if (kept.length < o.minAccepted) {
            return null;
        }

        const n = kept.length;
        const distances = kept.map((m) => m.distance);
        const distance = median(distances);
        const mean = distances.reduce((a, b) => a + b, 0) / n;
        const variance =
            distances.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1);
        const sigmaStat =
            (MEDIAN_EFFICIENCY * Math.sqrt(variance)) / Math.sqrt(n);
        const meanModelVar = kept.reduce((a, m) => a + m.sigma ** 2, 0) / n;
        const sigmaModel = Math.sqrt(meanModelVar / n);
        const sigmaSound = distance * o.soundSpeedRelError;

        return {
            distance,
            sigma: Math.hypot(sigmaStat, sigmaModel, sigmaSound),
            sigmaStat,
            sigmaModel,
            sigmaSound,
            accepted: n,
            window: this.history.length,
        };
    }
}
