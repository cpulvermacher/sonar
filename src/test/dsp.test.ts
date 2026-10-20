import { describe, expect, it } from 'vitest';
import { makeChirp } from '../dsp';

describe('makeChirp', () => {
    const fs = 48000;
    const chirp = makeChirp(fs, 2000, 12000, 0.005, 0.8);

    it('has the requested length', () => {
        expect(chirp.length).toBe(240);
    });

    it('is tapered to zero at both ends', () => {
        expect(Math.abs(chirp[0])).toBeLessThan(1e-6);
        expect(Math.abs(chirp[chirp.length - 1])).toBeLessThan(1e-3);
    });

    it('respects the amplitude', () => {
        const peak = chirp.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
        expect(peak).toBeLessThanOrEqual(0.8 + 1e-6);
        expect(peak).toBeGreaterThan(0.75);
    });

    it('sweeps upward in frequency', () => {
        // Count zero crossings in the first and last third.
        const crossings = (a: Float32Array) => {
            let c = 0;
            for (let i = 1; i < a.length; i++) {
                if (a[i - 1] < 0 !== a[i] < 0) {
                    c++;
                }
            }
            return c;
        };
        const third = Math.floor(chirp.length / 3);
        const early = crossings(chirp.subarray(0, third));
        const late = crossings(chirp.subarray(chirp.length - third));
        expect(late).toBeGreaterThan(2 * early);
    });
});
