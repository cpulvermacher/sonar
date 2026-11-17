import { describe, expect, it } from 'vitest';
import {
    chirpBand,
    DEFAULT_CONFIG,
    maxChirpFrequency,
    maxRange,
} from '../config';

describe('chirpBand', () => {
    it('multiplies both ends of the sweep and keeps the fade', () => {
        const band = chirpBand({
            ...DEFAULT_CONFIG,
            band: 'wide',
            frequencyScale: 1.5,
        });
        expect(band.f0).toBe(3000);
        expect(band.f1).toBe(30000);
        expect(band.taper).toBe(1);
    });

    it('leaves the default chirp as it was', () => {
        const band = chirpBand(DEFAULT_CONFIG);
        expect([band.f0, band.f1, band.taper]).toEqual([2000, 12000, 0.25]);
    });

    it('fits the scaled wide chirp at 96 kHz but not at 48 kHz', () => {
        const band = chirpBand({
            ...DEFAULT_CONFIG,
            band: 'wide',
            frequencyScale: 1.5,
        });
        expect(band.f1).toBeLessThanOrEqual(maxChirpFrequency(96000));
        expect(band.f1).toBeGreaterThan(maxChirpFrequency(48000));
    });
});

describe('maxRange', () => {
    const at = (rate: number) =>
        maxRange({ ...DEFAULT_CONFIG, interval: 1 / rate });

    it('ends a chirp before the next ping arrives', () => {
        // 20 pings/s: 39 ms left after the 10 ms chirp and the guard.
        expect(at(20)).toBeCloseTo((343.42 * 0.039) / 2 + 0.06, 6);
        expect(at(30)).toBeGreaterThan(3.5);
        expect(at(30)).toBeLessThan(4);
    });

    it('is capped at slow ping rates', () => {
        expect(at(10)).toBe(10);
        expect(at(4)).toBe(10);
    });
});
