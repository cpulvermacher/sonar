// Generic DSP helpers, shared by the main thread and the worker.

/**
 * Linear frequency sweep from f0 to f1 Hz with a Tukey window
 * (cosine-tapered ends) to avoid clicks and reduce correlation sidelobes.
 *
 * @param taper fraction of the length covered by the cosine tapers (0 = rectangular, 1 = Hann)
 */
export function makeChirp(
    sampleRate: number,
    f0: number,
    f1: number,
    duration: number,
    amplitude = 1,
    taper = 0.25
): Float32Array {
    const n = Math.round(duration * sampleRate);
    const out = new Float32Array(n);
    const k = (f1 - f0) / duration; // sweep rate in Hz/s
    const edge = (taper * (n - 1)) / 2;
    for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
        out[i] = amplitude * tukey(i, n, edge) * Math.sin(phase);
    }
    return out;
}

function tukey(i: number, n: number, edge: number): number {
    if (edge <= 0) {
        return 1;
    }
    const d = Math.min(i, n - 1 - i);
    if (d >= edge) {
        return 1;
    }
    return 0.5 * (1 - Math.cos((Math.PI * d) / edge));
}

/** Speed of sound in dry air (m/s) at the given temperature (°C). */
export function speedOfSound(temperature: number): number {
    return 331.3 + 0.606 * temperature;
}

export function nextPow2(n: number): number {
    return 2 ** Math.ceil(Math.log2(Math.max(1, n)));
}

/** In-place iterative radix-2 FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const angle = ((inverse ? 2 : -2) * Math.PI) / size;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let start = 0; start < n; start += size) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < half; k++) {
                const a = start + k;
                const b = a + half;
                const tr = re[b] * cr - im[b] * ci;
                const ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                const next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
    }
    if (inverse) {
        for (let i = 0; i < n; i++) {
            re[i] /= n;
            im[i] /= n;
        }
    }
}

/**
 * Matched filter for one chirp: the squared envelope of the cross-correlation
 * of a recording with the chirp. Using the analytic signal (negative
 * frequencies zeroed) gives a smooth envelope instead of a correlation that
 * oscillates at the carrier frequency.
 */
export class MatchedFilter {
    private readonly n: number;
    /** Conjugate spectrum of the chirp. */
    private readonly hr: Float64Array;
    private readonly hi: Float64Array;
    private readonly xr: Float64Array;
    private readonly xi: Float64Array;

    /**
     * @param maxLength longest recording that will be passed to power()
     * @param highpass frequencies below this (in cycles per sample) are
     *   ignored, e.g. hum and rumble below the chirp's band
     */
    constructor(chirp: Float32Array, maxLength: number, highpass = 0) {
        this.n = nextPow2(maxLength + chirp.length);
        this.hr = new Float64Array(this.n);
        this.hi = new Float64Array(this.n);
        this.hr.set(chirp);
        fft(this.hr, this.hi);
        for (let k = 0; k < this.n; k++) {
            const pass = k >= highpass * this.n;
            this.hr[k] = pass ? this.hr[k] : 0;
            this.hi[k] = pass ? -this.hi[k] : 0;
        }
        this.xr = new Float64Array(this.n);
        this.xi = new Float64Array(this.n);
    }

    /**
     * out[l] = |Σ x[n + l] · chirp[n]|² of the analytic signal, for lags
     * 0..x.length-1.
     */
    power(x: Float32Array): Float64Array {
        const n = this.n;
        const xr = this.xr;
        const xi = this.xi;
        const hr = this.hr;
        const hi = this.hi;
        if (x.length + 1 > n) {
            throw new Error('recording longer than the filter was built for');
        }
        xr.fill(0);
        xi.fill(0);
        xr.set(x);
        fft(xr, xi);
        const half = n / 2;
        for (let k = 0; k < n; k++) {
            const scale = k === 0 || k === half ? 1 : k < half ? 2 : 0;
            const re = xr[k] * hr[k] - xi[k] * hi[k];
            const im = xr[k] * hi[k] + xi[k] * hr[k];
            xr[k] = re * scale;
            xi[k] = im * scale;
        }
        fft(xr, xi, true);
        const out = new Float64Array(x.length);
        for (let i = 0; i < out.length; i++) {
            out[i] = xr[i] * xr[i] + xi[i] * xi[i];
        }
        return out;
    }
}

/** Index of the maximum of y in [from, to). */
export function argmax(y: ArrayLike<number>, from = 0, to = y.length): number {
    let best = from;
    for (let i = from + 1; i < to; i++) {
        if (y[i] > y[best]) {
            best = i;
        }
    }
    return best;
}

/** Sub-sample peak position by fitting a parabola through y[i-1..i+1]. */
export function parabolicInterp(y: ArrayLike<number>, i: number): number {
    if (i <= 0 || i >= y.length - 1) {
        return i;
    }
    const a = y[i - 1];
    const b = y[i];
    const c = y[i + 1];
    const denom = a - 2 * b + c;
    if (denom === 0) {
        return i;
    }
    const offset = (0.5 * (a - c)) / denom;
    return i + Math.max(-0.5, Math.min(0.5, offset));
}

export function median(y: ArrayLike<number>): number {
    if (y.length === 0) {
        return Number.NaN;
    }
    const sorted = Float64Array.from(y).sort();
    const mid = sorted.length >> 1;
    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}
