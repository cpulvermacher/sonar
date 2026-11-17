// Sonar parameters.

import { speedOfSound } from './dsp';

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

/**
 * Farthest distance searched for echoes in any case (m). Against the noise
 * in the recordings a wall would stay detectable to about 15 m, which only
 * an outdoor wall with nothing nearer could use; indoors the room's own
 * reverberation hides a wall from 2–3 m on.
 */
const MAX_RANGE_CAP = 10;

/**
 * Time (s) kept clear before the next ping's direct sound: its cluster
 * starts about 1 ms before the centroid that is the time reference.
 */
const NEXT_PING_GUARD = 1e-3;

/**
 * Echoes farther than this (m) are not searched for. The analysis needs a
 * whole chirp beyond the farthest echo, and that must end before the next
 * ping's direct sound, which is a hundred times stronger than an echo.
 */
export function maxRange(config: SonarConfig): number {
    const clear = config.interval - config.chirpDuration - NEXT_PING_GUARD;
    const range =
        (speedOfSound(config.temperature) * clear) / 2 + config.rangeOffset;
    return Math.min(MAX_RANGE_CAP, range);
}

/** Ping rates offered in the UI, in pings per second. */
export const PING_RATES = [4, 10, 20, 30];

/**
 * Which of several echoes is reported: strictly the nearest, or the nearest
 * unless another is the better guess (see nearPreferenceDb, motionBonusDb).
 */
export const ECHO_CHOICES = {
    balanced: 'Balanced',
    nearest: 'Nearest',
};

export type EchoChoice = keyof typeof ECHO_CHOICES;

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
    /**
     * Added to every measured distance (m). The delay is measured against
     * the sound that reaches the mic directly from the speaker, which has
     * itself travelled the speaker–mic distance; half of that is missing
     * from the measured range.
     */
    rangeOffset: number;
    /**
     * Echoes are not searched for closer than this (m, before rangeOffset):
     * there the phone's own response is too strong and too variable.
     */
    blindRange: number;
    /**
     * Beyond this (m), echoes are only reported when none is found nearer.
     * Indoors the room's reverberation is as strong there as a wall would
     * be, and changes whenever the phone moves, so it would pass for a
     * clearer or a moving echo. Indoors something (the floor, the ceiling)
     * is always nearer; this leaves the far range to open spaces.
     */
    reverbRange: number;
    /** Air temperature in °C, for the speed of sound. */
    temperature: number;
    /** Assumed uncertainty of the temperature, in °C. */
    temperatureSigma: number;
    /**
     * Weakest echo accepted from 0.5 m, in dB relative to the direct path;
     * it scales with 1/distance like the echo of a wall. Lower values also
     * pick up small or oblique objects (and the person holding the phone).
     */
    sensitivityDb: number;
    /** An echo must rise this much (dB) above the learned clutter floor. */
    minExcessDb: number;
    echoChoice: EchoChoice;
    /**
     * With echoChoice 'balanced': of several echoes, the nearest is
     * reported, unless it is close to the phone (where the phone's own
     * response sets the detection threshold) and clears the threshold by
     * this much (dB) less than an echo behind it does. Small values give up
     * weak near echoes, such as a hand, for anything clearer behind; 3 dB
     * was tried and lost them too often.
     */
    nearPreferenceDb: number;
    /**
     * With echoChoice 'balanced': an echo whose distance has been changing
     * counts as this much (dB) clearer, and is reported instead of one in
     * front of it that stays put and is not clearer than that.
     */
    motionBonusDb: number;
}

export const DEFAULT_CONFIG: SonarConfig = {
    band: 'audible',
    frequencyScale: 1,
    chirpDuration: 0.01,
    interval: 0.05,
    amplitude: 0.8,
    rangeOffset: 0.06,
    blindRange: 0.08,
    reverbRange: 2,
    temperature: 20,
    temperatureSigma: 2,
    sensitivityDb: -32,
    minExcessDb: 7,
    echoChoice: 'balanced',
    nearPreferenceDb: 6,
    motionBonusDb: 3,
};
