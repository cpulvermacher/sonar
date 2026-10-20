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
