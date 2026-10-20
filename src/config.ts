// Sonar parameters. Defaults only for now; the settings UI comes later.

export interface Band {
    label: string;
    /** Sweep start/end frequency in Hz. */
    f0: number;
    f1: number;
}

export const BANDS = {
    audible: { label: 'Audible 2–12 kHz', f0: 2000, f1: 12000 },
    ultrasonic: { label: 'Near-ultrasonic 16–20 kHz', f0: 16000, f1: 20000 },
} satisfies Record<string, Band>;

export type BandId = keyof typeof BANDS;

export interface SonarConfig {
    band: BandId;
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
}

export const DEFAULT_CONFIG: SonarConfig = {
    band: 'audible',
    chirpDuration: 0.005,
    interval: 0.25,
    amplitude: 0.8,
    minRange: 0.15,
    maxRange: 5,
    temperature: 20,
};
