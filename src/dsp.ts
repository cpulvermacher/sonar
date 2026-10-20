// Pure DSP functions, shared by the main thread and the worker.

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

export interface Biquad {
    b0: number;
    b1: number;
    b2: number;
    a1: number;
    a2: number;
}

/** 2nd-order highpass (RBJ cookbook); Q = 1/√2 gives a Butterworth response. */
export function highpassBiquad(
    sampleRate: number,
    cutoff: number,
    q = Math.SQRT1_2
): Biquad {
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return {
        b0: (1 + cos) / 2 / a0,
        b1: -(1 + cos) / a0,
        b2: (1 + cos) / 2 / a0,
        a1: (-2 * cos) / a0,
        a2: (1 - alpha) / a0,
    };
}

/** Runs the filter over x (transposed direct form II). */
export function applyBiquad(c: Biquad, x: Float32Array): Float32Array {
    const y = new Float32Array(x.length);
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < x.length; i++) {
        const out = c.b0 * x[i] + z1;
        z1 = c.b1 * x[i] - c.a1 * out + z2;
        z2 = c.b2 * x[i] - c.a2 * out;
        y[i] = out;
    }
    return y;
}

/** Forward-backward filtering: zero phase shift, squared magnitude response. */
export function filtfilt(c: Biquad, x: Float32Array): Float32Array {
    const y = applyBiquad(c, x).reverse();
    return applyBiquad(c, y).reverse();
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
 * Envelope of the cross-correlation of x with the template h:
 * env[l] = |Σ x[n + l] · h[n]| of the analytic signal, for lags 0..x.length-1.
 * Using the analytic signal (negative frequencies zeroed) gives a smooth
 * envelope instead of a correlation that oscillates at the carrier frequency.
 */
export function xcorrEnvelope(x: Float32Array, h: Float32Array): Float32Array {
    const n = nextPow2(x.length + h.length);
    const xr = new Float64Array(n);
    const xi = new Float64Array(n);
    const hr = new Float64Array(n);
    const hi = new Float64Array(n);
    xr.set(x);
    hr.set(h);
    fft(xr, xi);
    fft(hr, hi);
    // X · conj(H), one-sided spectrum.
    for (let k = 0; k < n; k++) {
        const scale = k === 0 || k === n / 2 ? 1 : k < n / 2 ? 2 : 0;
        const re = xr[k] * hr[k] + xi[k] * hi[k];
        const im = xi[k] * hr[k] - xr[k] * hi[k];
        xr[k] = re * scale;
        xi[k] = im * scale;
    }
    fft(xr, xi, true);
    const env = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
        env[i] = Math.hypot(xr[i], xi[i]);
    }
    return env;
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

/** Index of the largest local maximum of y in [from, to), or -1 if none. */
export function largestLocalMax(
    y: ArrayLike<number>,
    from: number,
    to: number
): number {
    let best = -1;
    for (let i = Math.max(1, from); i < Math.min(to, y.length - 1); i++) {
        if (
            y[i] >= y[i - 1] &&
            y[i] > y[i + 1] &&
            (best < 0 || y[i] > y[best])
        ) {
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

export interface Peak {
    /** Sub-sample position within the analysed window. */
    index: number;
    amplitude: number;
}

export interface PingAnalysis {
    direct: Peak;
    echo: Peak | null;
    /** Median of the correlation envelope; the noise reference for SNR. */
    noiseFloor: number;
    envelope: Float32Array;
}

export interface AnalysisParams {
    highpass: Biquad;
    /** The direct path is searched for in [0, directSearchEnd). */
    directSearchEnd: number;
    /** Echoes are searched for in (direct + blank, direct + maxLag]. */
    blank: number;
    maxLag: number;
}

/**
 * Highpass, matched filter, and peak picking for one recorded ping.
 * The direct (speaker → mic) path is the strongest peak; the echo is the
 * strongest local maximum after the blanking interval.
 */
export function analyzePing(
    x: Float32Array,
    chirp: Float32Array,
    p: AnalysisParams
): PingAnalysis {
    const filtered = filtfilt(p.highpass, x);
    const envelope = xcorrEnvelope(filtered, chirp);

    const d = argmax(envelope, 0, Math.min(p.directSearchEnd, envelope.length));
    const direct = {
        index: parabolicInterp(envelope, d),
        amplitude: envelope[d],
    };

    const e = largestLocalMax(envelope, d + p.blank, d + p.maxLag + 1);
    const echo =
        e < 0
            ? null
            : { index: parabolicInterp(envelope, e), amplitude: envelope[e] };

    return { direct, echo, noiseFloor: median(envelope), envelope };
}

/**
 * RMS bandwidth (Hz) of x around its spectral centroid. This is the bandwidth
 * that limits delay precision when only the correlation envelope is used.
 */
export function rmsBandwidth(x: Float32Array, sampleRate: number): number {
    const n = nextPow2(4 * x.length);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(x);
    fft(re, im);
    let p = 0;
    let pf = 0;
    let pff = 0;
    for (let k = 0; k <= n / 2; k++) {
        const f = (k * sampleRate) / n;
        const power = re[k] * re[k] + im[k] * im[k];
        p += power;
        pf += power * f;
        pff += power * f * f;
    }
    const centroid = pf / p;
    return Math.sqrt(Math.max(0, pff / p - centroid * centroid));
}

/**
 * Power SNR of an envelope peak. Noise in the analytic correlation has a
 * Rayleigh-distributed magnitude, whose mean power is median² / ln 2.
 */
export function peakSnr(amplitude: number, noiseMedian: number): number {
    return (amplitude * amplitude * Math.LN2) / (noiseMedian * noiseMedian);
}

/**
 * Approximate standard deviation (s) of a delay estimate, from the
 * Cramér–Rao bound for a signal with RMS bandwidth `bandwidth` at power SNR `snr`.
 */
export function delaySigma(snr: number, bandwidth: number): number {
    return 1 / (2 * Math.PI * bandwidth * Math.sqrt(Math.max(snr, 1e-9)));
}
