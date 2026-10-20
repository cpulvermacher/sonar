import { describe, expect, it } from 'vitest';
import {
    analyzePing,
    delaySigma,
    fft,
    filtfilt,
    highpassBiquad,
    largestProminentPeak,
    makeChirp,
    median,
    nextPow2,
    peakSnr,
    prominence,
    rmsBandwidth,
    xcorrEnvelope,
} from '../dsp';

function sine(fs: number, f: number, n: number, amplitude = 1): Float32Array {
    return Float32Array.from(
        { length: n },
        (_, i) => amplitude * Math.sin((2 * Math.PI * f * i) / fs)
    );
}

function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
    let sum = 0;
    for (let i = from; i < to; i++) {
        sum += x[i] * x[i];
    }
    return Math.sqrt(sum / (to - from));
}

/** Delays x by a (fractional) number of samples via a frequency-domain phase shift. */
function delayed(x: Float32Array, delay: number, length: number): Float32Array {
    const n = nextPow2(length + x.length);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(x);
    fft(re, im);
    for (let k = 0; k < n; k++) {
        const f = k <= n / 2 ? k : k - n;
        const phi = (-2 * Math.PI * f * delay) / n;
        const [r, i] = [re[k], im[k]];
        re[k] = r * Math.cos(phi) - i * Math.sin(phi);
        im[k] = r * Math.sin(phi) + i * Math.cos(phi);
    }
    fft(re, im, true);
    return Float32Array.from(re.subarray(0, length));
}

/** Deterministic standard normal noise (mulberry32 + Box–Muller). */
function noise(n: number, sigma: number, seed = 1): Float32Array {
    let s = seed;
    const rand = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return Float32Array.from(
        { length: n },
        () =>
            sigma *
            Math.sqrt(-2 * Math.log(rand() + 1e-12)) *
            Math.cos(2 * Math.PI * rand())
    );
}

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

describe('highpass filtfilt', () => {
    const fs = 48000;
    const n = 9600;
    const hp = highpassBiquad(fs, 1400);
    // Ignore the edges, where the filter settles.
    const mid: [number, number] = [2000, n - 2000];

    it('attenuates 50 Hz hum by more than 20 dB', () => {
        const y = filtfilt(hp, sine(fs, 50, n));
        const gain = rms(y, ...mid) / rms(sine(fs, 50, n), ...mid);
        expect(20 * Math.log10(gain)).toBeLessThan(-20);
    });

    it('passes an in-band 5 kHz tone within 1 dB and without phase shift', () => {
        const x = sine(fs, 5000, n);
        const y = filtfilt(hp, x);
        const gain = rms(y, ...mid) / rms(x, ...mid);
        expect(Math.abs(20 * Math.log10(gain))).toBeLessThan(1);
        for (let i = mid[0]; i < mid[1]; i++) {
            expect(Math.abs(y[i] - x[i])).toBeLessThan(0.02);
        }
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
        const re = Float64Array.from({ length: n }, (_, i) =>
            Math.cos((2 * Math.PI * 5 * i) / n)
        );
        const im = new Float64Array(n);
        fft(re, im);
        expect(re[5]).toBeCloseTo(n / 2, 9);
        expect(re[n - 5]).toBeCloseTo(n / 2, 9);
        expect(Math.abs(re[6])).toBeLessThan(1e-9);
    });
});

describe('analyzePing', () => {
    const fs = 48000;
    const chirp = makeChirp(fs, 2000, 12000, 0.005);
    const n = 12000;
    const directAt = 1000;
    const echoDelay = 1234.37;

    const x = delayed(chirp, directAt, n);
    const echo = delayed(chirp, directAt + echoDelay, n);
    const hum = sine(fs, 50, n, 0.3);
    const hiss = noise(n, 0.01);
    for (let i = 0; i < n; i++) {
        x[i] += 0.4 * echo[i] + hum[i] + hiss[i];
    }

    const result = analyzePing(x, chirp, {
        highpass: highpassBiquad(fs, 1400),
        directSearchEnd: 6000,
        blank: 40,
        maxLag: 3000,
        minProminence: 2,
    });

    it('finds the direct path', () => {
        expect(result.direct.index).toBeCloseTo(directAt, 0);
    });

    it('recovers the echo delay to sub-sample precision', () => {
        expect(result.echo).not.toBeNull();
        const measured = (result.echo?.index ?? 0) - result.direct.index;
        expect(Math.abs(measured - echoDelay)).toBeLessThan(0.2);
    });

    it('reports an echo well above the noise floor', () => {
        expect(result.echo?.amplitude ?? 0).toBeGreaterThan(
            10 * result.noiseFloor
        );
    });

    it('finds no echo beyond maxLag', () => {
        const short = analyzePing(x, chirp, {
            highpass: highpassBiquad(fs, 1400),
            directSearchEnd: 6000,
            blank: 40,
            maxLag: 1000,
            minProminence: 2,
        });
        // Only sidelobes/noise remain in range, far below the real echo.
        expect(short.echo?.amplitude ?? 0).toBeLessThan(
            0.2 * (result.echo?.amplitude ?? 0)
        );
    });
});

describe('prominence', () => {
    it('is large for an isolated peak and ~1 for a bump on a flank', () => {
        //        0  1  2   3  4    5    6    7  8  9
        const y = [1, 2, 10, 6, 5.8, 5.9, 3.0, 1, 4, 1];
        expect(prominence(y, 2)).toBeCloseTo(10 / 1, 9); // main peak
        expect(prominence(y, 5)).toBeCloseTo(5.9 / 5.8, 9); // flank bump
        expect(prominence(y, 8)).toBeCloseTo(4 / 1, 9); // separate echo
    });

    it('picks the strongest prominent peak, not the flank bump', () => {
        const y = [1, 2, 10, 6, 5.8, 5.9, 3.0, 1, 4, 1];
        expect(largestProminentPeak(y, 3, 10, 2)).toBe(8);
        expect(largestProminentPeak(y, 3, 10, 5)).toBe(-1);
    });
});

describe('analyzePing with a smeared direct path', () => {
    // Speaker ringing: the direct path followed by a rippled, decaying train
    // of closely spaced copies, plus a weak real echo further out.
    const fs = 48000;
    const chirp = makeChirp(fs, 2000, 12000, 0.005);
    const n = 8000;
    const directAt = 1000;
    const echoDelay = 600.4;
    const x = new Float32Array(n);
    for (let k = 0; k < 30; k++) {
        const copy = delayed(chirp, directAt + 2.5 * k, n);
        for (let i = 0; i < n; i++) {
            x[i] += 0.88 ** k * (1 + 0.4 * Math.sin(k)) * copy[i];
        }
    }
    const echo = delayed(chirp, directAt + echoDelay, n);
    const hiss = noise(n, 0.002, 5);
    for (let i = 0; i < n; i++) {
        x[i] += 0.1 * echo[i] + hiss[i];
    }

    const analyse = (minProminence: number) =>
        analyzePing(x, chirp, {
            highpass: highpassBiquad(fs, 1400),
            directSearchEnd: 4000,
            // Blanking ends inside the ringing tail.
            blank: 20,
            maxLag: 2000,
            minProminence,
        });
    const delayOf = (r: ReturnType<typeof analyse>) =>
        (r.echo?.index ?? 0) - r.direct.index;

    it('picks a bump on the flank when any local maximum is accepted', () => {
        // Prominence ratio >= 1 holds for every peak: the old behaviour.
        expect(delayOf(analyse(1))).toBeLessThan(100);
    });

    it('skips the flank and finds the real echo', () => {
        const result = analyse(2);
        expect(result.echo).not.toBeNull();
        expect(Math.abs(delayOf(result) - echoDelay)).toBeLessThan(5);
    });
});

describe('uncertainty model', () => {
    const fs = 48000;

    it('computes the RMS bandwidth of a linear sweep (≈ B/√12)', () => {
        const chirp = makeChirp(fs, 2000, 12000, 0.005);
        const b = rmsBandwidth(chirp, fs);
        expect(b).toBeGreaterThan(0.8 * (10000 / Math.sqrt(12)));
        expect(b).toBeLessThan(1.2 * (10000 / Math.sqrt(12)));
    });

    it('estimates noise power from the envelope median', () => {
        const chirp = makeChirp(fs, 2000, 12000, 0.005);
        const env = xcorrEnvelope(noise(32768, 1, 3), chirp);
        let power = 0;
        for (const v of env) {
            power += v * v;
        }
        power /= env.length;
        // An envelope sample equal to the noise RMS has power SNR 1.
        const snr = peakSnr(Math.sqrt(power), median(env));
        expect(snr).toBeGreaterThan(0.9);
        expect(snr).toBeLessThan(1.1);
    });

    it('shrinks the delay sigma with increasing SNR', () => {
        expect(delaySigma(100, 3000)).toBeLessThan(delaySigma(10, 3000));
        expect(delaySigma(100, 3000) / delaySigma(10000, 3000)).toBeCloseTo(
            10,
            6
        );
    });

    it('matches the observed scatter of delay estimates', () => {
        // Repeated noisy pings: the spread of the measured delay should be of
        // the order of the predicted sigma.
        const chirp = makeChirp(fs, 2000, 12000, 0.005);
        const bandwidth = rmsBandwidth(chirp, fs);
        const n = 4096;
        const clean = delayed(chirp, 1000.3, n);
        const params = {
            highpass: highpassBiquad(fs, 1400),
            directSearchEnd: n,
            blank: 40,
            maxLag: 100,
            minProminence: 2,
        };
        const delays: number[] = [];
        const sigmas: number[] = [];
        for (let seed = 1; seed <= 40; seed++) {
            const x = clean.slice();
            const hiss = noise(n, 0.05, seed);
            for (let i = 0; i < n; i++) {
                x[i] += hiss[i];
            }
            const r = analyzePing(x, chirp, params);
            delays.push(r.direct.index);
            sigmas.push(
                delaySigma(
                    peakSnr(r.direct.amplitude, r.noiseFloor),
                    bandwidth
                ) * fs
            );
        }
        const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
        const observed = Math.sqrt(
            delays.reduce((a, d) => a + (d - mean) ** 2, 0) /
                (delays.length - 1)
        );
        const predicted = median(sigmas);
        expect(observed).toBeGreaterThan(predicted / 4);
        expect(observed).toBeLessThan(predicted * 4);
    });
});
