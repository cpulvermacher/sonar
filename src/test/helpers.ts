// Signal generators shared by the tests.

import { fft, nextPow2 } from '../dsp';

export function sine(
    fs: number,
    f: number,
    n: number,
    amplitude = 1
): Float32Array {
    return Float32Array.from(
        { length: n },
        (_, i) => amplitude * Math.sin((2 * Math.PI * f * i) / fs)
    );
}

/** Delays x by a (fractional) number of samples via a frequency-domain phase shift. */
export function delayed(
    x: Float32Array,
    delay: number,
    length: number
): Float32Array {
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
export function noise(n: number, sigma: number, seed = 1): Float32Array {
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

/** Adds `gain` times `x` to `target`, in place. */
export function mix(target: Float32Array, x: Float32Array, gain = 1): void {
    for (let i = 0; i < target.length && i < x.length; i++) {
        target[i] += gain * x[i];
    }
}
