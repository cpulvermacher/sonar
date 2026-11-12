import { describe, expect, it } from 'vitest';
import {
    argmax,
    fft,
    MatchedFilter,
    makeChirp,
    median,
    parabolicInterp,
} from '../dsp';
import { delayed, mix, noise, sine } from './helpers';

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

describe('fft', () => {
    it('round-trips', () => {
        const x = noise(256, 1, 7);
        const re = Float64Array.from(x);
        const im = new Float64Array(256);
        fft(re, im);
        fft(re, im, true);
        for (let i = 0; i < 256; i++) {
            expect(re[i]).toBeCloseTo(x[i], 9);
            expect(im[i]).toBeCloseTo(0, 9);
        }
    });

    it('puts a pure tone into a single bin', () => {
        const n = 64;
        const re = Float64Array.from(sine(n, 5, n));
        const im = new Float64Array(n);
        fft(re, im);
        const mag = Array.from(re, (r, k) => Math.hypot(r, im[k]));
        expect(mag[5]).toBeCloseTo(n / 2, 6);
        expect(mag[n - 5]).toBeCloseTo(n / 2, 6);
        expect(mag[4]).toBeLessThan(1e-9);
    });
});

describe('MatchedFilter', () => {
    const fs = 48000;
    const chirp = makeChirp(fs, 2000, 12000, 0.005);
    const n = 4000;

    it('peaks where the chirp starts, with a smooth envelope', () => {
        const filter = new MatchedFilter(chirp, n);
        const power = filter.power(delayed(chirp, 1000.3, n));
        const peak = argmax(power);
        expect(peak).toBe(1000);
        expect(parabolicInterp(power, peak)).toBeCloseTo(1000.3, 1);
        // No carrier ripple: monotonic over the main lobe's flanks.
        expect(power[peak - 1]).toBeGreaterThan(power[peak - 2]);
        expect(power[peak + 1]).toBeGreaterThan(power[peak + 2]);
    });

    it('can be reused for recordings of different lengths', () => {
        const filter = new MatchedFilter(chirp, n);
        expect(argmax(filter.power(delayed(chirp, 300, n)))).toBe(300);
        const short = filter.power(delayed(chirp, 100, 1000));
        expect(short.length).toBe(1000);
        expect(argmax(short)).toBe(100);
        expect(() => filter.power(new Float32Array(100000))).toThrow();
    });

    it('ignores hum below its highpass', () => {
        const x = delayed(chirp, 1000, n);
        mix(x, sine(fs, 50, n), 5);
        const far = (filter: MatchedFilter) => {
            const power = filter.power(x);
            return power[3000] / power[1000];
        };
        const plain = far(new MatchedFilter(chirp, n));
        const highpassed = far(new MatchedFilter(chirp, n, 1400 / fs));
        expect(highpassed).toBeLessThan(plain / 100);
    });
});

describe('small helpers', () => {
    it('finds the vertex of a sampled parabola', () => {
        const y = [-2, -1, 0, 1, 2].map((x) => 5 - (x - 0.3) ** 2);
        expect(parabolicInterp(y, 2)).toBeCloseTo(2.3, 9);
        expect(parabolicInterp(y, 0)).toBe(0);
    });

    it('takes the median of even and odd counts', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 2, 3])).toBe(2.5);
        expect(median([])).toBeNaN();
    });
});
