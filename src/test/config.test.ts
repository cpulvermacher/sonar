import { describe, expect, it } from 'vitest';
import { chirpBand, DEFAULT_CONFIG, maxChirpFrequency } from '../config';

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
