// Sonar parameters. Defaults only for now; the settings UI comes later.

export interface Band {
    label: string;
    /** Sweep start/end frequency in Hz. */
    f0: number;
    f1: number;
    /** Fraction of the chirp covered by its cosine fades, see makeChirp. */
    taper: number;
}

export const BANDS = {
    audible: {
        label: '2–12 kHz, light fade',
        f0: 2000,
        f1: 12000,
        taper: 0.25,
    },
    // A full (Hann) fade: correlation sidelobes about −47 dB instead of
    // −14 dB. The wider sweep keeps the main lobe as narrow as above.
    wide: { label: '2–20 kHz, full fade', f0: 2000, f1: 20000, taper: 1 },
    ultrasonic: {
        label: '16–20 kHz, light fade',
        f0: 16000,
        f1: 20000,
        taper: 0.25,
    },
} satisfies Record<string, Band>;

export type BandId = keyof typeof BANDS;

/** The band as emitted: its frequencies multiplied by config.frequencyScale. */
export function chirpBand(config: SonarConfig): Band {
    const band = BANDS[config.band];
    return {
        ...band,
        f0: band.f0 * config.frequencyScale,
        f1: band.f1 * config.frequencyScale,
    };
}

/**
 * Highest chirp frequency playable at this sample rate, with some room below
 * Nyquist for the anti-aliasing filters.
 */
export function maxChirpFrequency(sampleRate: number): number {
    return 0.45 * sampleRate;
}

export interface SonarConfig {
    band: BandId;
    /** Multiplies the band's frequencies, e.g. to move it into ultrasound. */
    frequencyScale: number;
    /** Chirp duration in seconds. */
    chirpDuration: number;
    /** Time between pings in seconds. */
    interval: number;
    /** Peak amplitude of the emitted chirp (0..1). */
    amplitude: number;
    /** Echoes closer than this (m) are ignored; masks the direct path's tail. */
    minRange: number;
    /** Echoes farther than this (m) are not searched for. */
    maxRange: number;
    /** Air temperature in °C, for the speed of sound. */
    temperature: number;
    /** Assumed uncertainty of the temperature, in °C. */
    temperatureSigma: number;
    /** Number of recent pings the distance estimate is based on. */
    averagePings: number;
    /** Echoes with a lower SNR (dB) are ignored. */
    minEchoSnrDb: number;
    /** An echo peak must rise this much (dB) above the trough before a taller neighbour. */
    minEchoProminenceDb: number;
}

export const DEFAULT_CONFIG: SonarConfig = {
    band: 'audible',
    frequencyScale: 1,
    chirpDuration: 0.01,
    interval: 0.25,
    amplitude: 0.8,
    minRange: 0.15,
    maxRange: 2,
    temperature: 20,
    temperatureSigma: 2,
    averagePings: 10,
    minEchoSnrDb: 18,
    minEchoProminenceDb: 6,
};
