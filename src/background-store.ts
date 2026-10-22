// Calibrated backgrounds (see dsp.Background), kept in this browser for each
// sample rate and chirp, since the profile is per sample of that chirp's
// correlation. Storage may be unavailable; then nothing is remembered.

import type { SonarConfig } from './config';

export interface StoredBackground {
    createdAt: string;
    power: Float32Array;
}

function key(sampleRate: number, config: SonarConfig): string {
    return `sonar.background.v1:${sampleRate}:${config.band}:${config.chirpDuration}`;
}

export function loadBackground(
    sampleRate: number,
    config: SonarConfig
): StoredBackground | null {
    try {
        const raw = localStorage.getItem(key(sampleRate, config));
        if (!raw) {
            return null;
        }
        const stored = JSON.parse(raw) as {
            createdAt: string;
            power: number[];
        };
        return {
            createdAt: stored.createdAt,
            power: Float32Array.from(stored.power),
        };
    } catch {
        return null;
    }
}

export function saveBackground(
    sampleRate: number,
    config: SonarConfig,
    bg: StoredBackground
): void {
    try {
        localStorage.setItem(
            key(sampleRate, config),
            JSON.stringify({
                createdAt: bg.createdAt,
                power: Array.from(bg.power),
            })
        );
    } catch {
        // Not persisted; still used for this session.
    }
}

export function clearBackground(sampleRate: number, config: SonarConfig): void {
    try {
        localStorage.removeItem(key(sampleRate, config));
    } catch {
        // Nothing stored.
    }
}
