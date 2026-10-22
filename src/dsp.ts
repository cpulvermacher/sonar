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

/** Complex samples, as separate real and imaginary parts. */
export interface ComplexArray<T = Float32Array> {
    re: T;
    im: T;
}

/**
 * Spectrum of the analytic cross-correlation of x with the template h:
 * X · conj(H) with the negative frequencies zeroed. Its inverse FFT at lag l
 * is Σ x[n + l] · h[n] plus j times its Hilbert transform.
 */
function xcorrSpectrum(
    x: Float32Array,
    h: Float32Array
): ComplexArray<Float64Array> {
    const n = nextPow2(x.length + h.length);
    const xr = new Float64Array(n);
    const xi = new Float64Array(n);
    const hr = new Float64Array(n);
    const hi = new Float64Array(n);
    xr.set(x);
    hr.set(h);
    fft(xr, xi);
    fft(hr, hi);
    for (let k = 0; k < n; k++) {
        const scale = k === 0 || k === n / 2 ? 1 : k < n / 2 ? 2 : 0;
        const re = xr[k] * hr[k] + xi[k] * hi[k];
        const im = xi[k] * hr[k] - xr[k] * hi[k];
        xr[k] = re * scale;
        xi[k] = im * scale;
    }
    return { re: xr, im: xi };
}

/**
 * The correlation from its spectrum, advanced by `shift` samples (which may
 * be fractional): out[l] is the correlation at lag l + shift.
 */
function correlationAt(
    spectrum: ComplexArray<Float64Array>,
    shift: number
): ComplexArray<Float64Array> {
    const n = spectrum.re.length;
    const re = spectrum.re.slice();
    const im = spectrum.im.slice();
    if (shift !== 0) {
        for (let k = 0; k < n; k++) {
            // A real (two-sided) frequency index, so the phase ramp is smooth
            // around n/2; only k < n/2 is non-zero anyway.
            const w = (2 * Math.PI * (k < n / 2 ? k : k - n) * shift) / n;
            const c = Math.cos(w);
            const s = Math.sin(w);
            const r = re[k] * c - im[k] * s;
            im[k] = re[k] * s + im[k] * c;
            re[k] = r;
        }
    }
    fft(re, im, true);
    return { re, im };
}

function magnitude(
    y: ComplexArray<Float64Array>,
    length: number
): Float32Array {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        out[i] = Math.hypot(y.re[i], y.im[i]);
    }
    return out;
}

/**
 * Envelope of the cross-correlation of x with the template h:
 * env[l] = |Σ x[n + l] · h[n]| of the analytic signal, for lags 0..x.length-1.
 * Using the analytic signal (negative frequencies zeroed) gives a smooth
 * envelope instead of a correlation that oscillates at the carrier frequency.
 */
export function xcorrEnvelope(x: Float32Array, h: Float32Array): Float32Array {
    return magnitude(correlationAt(xcorrSpectrum(x, h), 0), x.length);
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

/**
 * Prominence of the peak at i, as a ratio: y[i] divided by the higher of the
 * two troughs separating it from a taller point on either side (or from the
 * array edge). A bump on the flank of a bigger peak has a ratio close to 1.
 */
export function prominence(y: ArrayLike<number>, i: number): number {
    const peak = y[i];
    let left = peak;
    for (let j = i - 1; j >= 0 && y[j] <= peak; j--) {
        left = Math.min(left, y[j]);
    }
    let right = peak;
    for (let j = i + 1; j < y.length && y[j] <= peak; j++) {
        right = Math.min(right, y[j]);
    }
    return peak / Math.max(left, right, 1e-12);
}

/** Indices of the local maxima of y in [from, to), strongest first. */
export function localMaxima(
    y: ArrayLike<number>,
    from: number,
    to: number
): number[] {
    const maxima: number[] = [];
    for (let i = Math.max(1, from); i < Math.min(to, y.length - 1); i++) {
        if (y[i] >= y[i - 1] && y[i] > y[i + 1]) {
            maxima.push(i);
        }
    }
    return maxima.sort((a, b) => y[b] - y[a]);
}

/**
 * Index of the largest local maximum of y in [from, to) whose prominence
 * ratio is at least minProminence, or -1 if there is none.
 */
export function largestProminentPeak(
    y: ArrayLike<number>,
    from: number,
    to: number,
    minProminence: number
): number {
    // Strongest first; the first prominent one wins, so typically only a
    // few prominences need computing.
    return (
        localMaxima(y, from, to).find(
            (i) => prominence(y, i) >= minProminence
        ) ?? -1
    );
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

export interface PeakCandidate extends Peak {
    /** Prominence ratio, see prominence(). */
    prominence: number;
}

/** Number of echo candidates reported for display. */
const MAX_CANDIDATES = 8;

export interface PingAnalysis {
    direct: Peak;
    echo: Peak | null;
    /** The strongest local maxima in the echo search range, strongest first. */
    candidates: PeakCandidate[];
    /** Median of the correlation envelope; the noise reference for SNR. */
    noiseFloor: number;
    /**
     * Correlation envelope. Like `searched`, it is resampled so that the
     * direct peak falls exactly on a sample; positions on it are off from
     * the reported ones by less than half a sample.
     */
    envelope: Float32Array;
    /** The envelope the echo was searched in: with the background removed, if any. */
    searched: Float32Array;
    /** The correlation after the direct peak, see Background; maxLag + 1 lags. */
    profile: ComplexArray;
}

/**
 * Static clutter close to the device: the direct path's own tail, the
 * speaker's ringing and reflections off the case, the hand holding it or the
 * surface it lies on. As the complex correlation relative to the direct peak
 * (divided by its complex value at the peak, after sub-sample alignment),
 * per sample of lag after it. Within a session it repeats in amplitude and
 * phase, so it can be subtracted coherently, leaving a wall echo that is
 * weaker than the clutter it overlaps.
 */
export type Background = ComplexArray;

export interface AnalysisParams {
    highpass: Biquad;
    /** The direct path is searched for in [0, directSearchEnd). */
    directSearchEnd: number;
    /** Echoes are searched for in (direct + blank, direct + maxLag]. */
    blank: number;
    maxLag: number;
    /** Minimum prominence ratio of an echo peak. */
    minProminence: number;
    /** Subtracted from the correlation before searching for the echo. */
    background?: Background | null;
}

/**
 * Highpass, matched filter, and peak picking for one recorded ping.
 * The direct (speaker → mic) path is the strongest peak; the echo is the
 * strongest sufficiently prominent peak after the blanking interval, so the
 * direct path's decaying flank is not mistaken for an echo.
 */
export function analyzePing(
    x: Float32Array,
    chirp: Float32Array,
    p: AnalysisParams
): PingAnalysis {
    const filtered = filtfilt(p.highpass, x);
    const spectrum = xcorrSpectrum(filtered, chirp);
    const unaligned = magnitude(correlationAt(spectrum, 0), x.length);
    const d = argmax(
        unaligned,
        0,
        Math.min(p.directSearchEnd, unaligned.length)
    );
    const directIndex = parabolicInterp(unaligned, d);

    // Resampled so the direct peak is exactly at d. The background is
    // relative to that peak, so it must be aligned to a fraction of the
    // carrier period, not just to the nearest sample.
    const shift = directIndex - d;
    const corr = correlationAt(spectrum, shift);
    const envelope = magnitude(corr, x.length);
    const direct = { index: directIndex, amplitude: envelope[d] };
    const profile = directProfile(corr, d, p.maxLag + 1);

    const searched = p.background
        ? removeBackground(envelope, corr, d, p.blank, p.background)
        : envelope;
    const from = d + p.blank;
    const to = d + p.maxLag + 1;
    const e = largestProminentPeak(searched, from, to, p.minProminence);
    const echo =
        e < 0
            ? null
            : {
                  index: parabolicInterp(searched, e) + shift,
                  amplitude: searched[e],
              };
    const candidates = localMaxima(searched, from, to)
        .slice(0, MAX_CANDIDATES)
        .map((i) => ({
            index: parabolicInterp(searched, i) + shift,
            amplitude: searched[i],
            prominence: prominence(searched, i),
        }));

    return {
        direct,
        echo,
        candidates,
        noiseFloor: median(envelope),
        envelope,
        searched,
        profile,
    };
}

/**
 * The correlation for lags 0..length-1 after the direct peak at d, divided
 * by its value at d (0 past the end of the recording).
 */
function directProfile(
    corr: ComplexArray<Float64Array>,
    d: number,
    length: number
): ComplexArray {
    const re = new Float32Array(length);
    const im = new Float32Array(length);
    const ar = corr.re[d];
    const ai = corr.im[d];
    const a2 = ar * ar + ai * ai;
    for (let j = 0; j < length && d + j < corr.re.length; j++) {
        const yr = corr.re[d + j];
        const yi = corr.im[d + j];
        re[j] = (yr * ar + yi * ai) / a2;
        im[j] = (yi * ar - yr * ai) / a2;
    }
    return { re, im };
}

/**
 * Background from calibration profiles (PingAnalysis.profile): their complex
 * mean. It ends where its local power drops below minAboveNoise × noisePower
 * (relative to the direct peak), so that only the device's own clutter is
 * removed, not objects further out in the calibration scene, which would
 * otherwise come back as ghosts once they are gone. Lags before `start` are
 * never used.
 */
export function makeBackground(
    profiles: ComplexArray[],
    noisePower: number,
    start: number,
    { smooth = 8, minAboveNoise = 4 } = {}
): Background {
    const length = Math.min(...profiles.map((p) => p.re.length));
    const re = new Float32Array(length);
    const im = new Float32Array(length);
    for (const p of profiles) {
        for (let j = 0; j < length; j++) {
            re[j] += p.re[j] / profiles.length;
            im[j] += p.im[j] / profiles.length;
        }
    }
    let end = start;
    for (; end < length; end++) {
        let sum = 0;
        let n = 0;
        for (
            let k = Math.max(0, end - smooth);
            k <= Math.min(length - 1, end + smooth);
            k++
        ) {
            sum += re[k] * re[k] + im[k] * im[k];
            n++;
        }
        if (sum / n < minAboveNoise * noisePower) {
            break;
        }
    }
    return { re: re.slice(0, end), im: im.slice(0, end) };
}

/**
 * A copy of the envelope in which lags `start` onwards after the direct peak
 * at d are replaced by the magnitude of the correlation minus the background,
 * scaled to this ping's direct peak.
 */
export function removeBackground(
    envelope: Float32Array,
    corr: ComplexArray<ArrayLike<number>>,
    d: number,
    start: number,
    bg: Background
): Float32Array {
    const out = envelope.slice();
    const ar = corr.re[d];
    const ai = corr.im[d];
    for (let j = start; j < bg.re.length && d + j < out.length; j++) {
        out[d + j] = Math.hypot(
            corr.re[d + j] - (bg.re[j] * ar - bg.im[j] * ai),
            corr.im[d + j] - (bg.re[j] * ai + bg.im[j] * ar)
        );
    }
    return out;
}

/** Power of the background relative to the direct peak, per lag. */
export function backgroundPower(bg: Background): Float32Array {
    return bg.re.map((r, j) => r * r + bg.im[j] * bg.im[j]);
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
