import { describe, expect, it } from 'vitest';
import { PingAnalyser } from '../analyser';
import { DEFAULT_CONFIG } from '../config';
import { makeChirp } from '../dsp';
import { delayed, mix, noise } from './helpers';

const fs = 48000;
const config = { ...DEFAULT_CONFIG, interval: 0.05 };
const period = 2400;
const chirp = makeChirp(fs, 2000, 12000, 0.005);
const mps = 343.42 / fs / 2;
/** Round-trip delay of the simulated echo, in samples. */
const ECHO_DELAY = 250.5;
const ECHO_DISTANCE = ECHO_DELAY * mps + config.rangeOffset;

/**
 * A mic stream with one chirp per period, each arriving `latency(k)` frames
 * after it was scheduled, with gain `gain(k)`, followed by its echo.
 */
function stream(
    pings: number,
    latency: (k: number) => number,
    gain: (k: number) => number = () => 1
): Float32Array {
    const n = (pings + 4) * period + 16000;
    const x = noise(n, 0.001);
    for (let k = 0; k < pings; k++) {
        const at = k * period + latency(k);
        const whole = Math.floor(at);
        const one = delayed(chirp, at - whole, chirp.length + 600);
        mix(one, delayed(chirp, at - whole + ECHO_DELAY, one.length), 0.1);
        for (let i = 0; i < one.length && whole + i < n; i++) {
            x[whole + i] += gain(k) * one[i];
        }
    }
    return x;
}

/** Runs the pings through an analyser the way the worker does. */
function analyse(x: Float32Array, pings: number) {
    const analyser = new PingAnalyser(chirp, fs, config);
    return Array.from({ length: pings }, (_, k) => {
        const emitFrame = k * period;
        const window = analyser.window(emitFrame);
        const slice = new Float32Array(window.length);
        for (let i = 0; i < slice.length; i++) {
            slice[i] = x[window.start + i] ?? 0;
        }
        return {
            window,
            ...analyser.process(emitFrame, window, slice),
        };
    });
}

describe('PingAnalyser', () => {
    it('finds the latency, even when it is longer than the ping period', () => {
        const latency = 7000.3;
        const results = analyse(
            stream(12, () => latency),
            12
        );
        // Nothing has arrived yet during the first two periods.
        expect(results.slice(0, 3).map((r) => r.valid)).toEqual([
            false,
            false,
            true,
        ]);
        expect(results[1].latency).toBeNull();
        for (const r of results.slice(2)) {
            expect(r.valid).toBe(true);
            expect(r.latency).toBeCloseTo(latency, 0);
            expect(
                Math.abs((r.distance as number) - ECHO_DISTANCE)
            ).toBeLessThan(0.004);
        }
    });

    it('needs only a short window once the latency is known', () => {
        const results = analyse(
            stream(6, () => 1000),
            6
        );
        expect(results[0].window.acquiring).toBe(true);
        expect(results[0].window.length).toBeGreaterThan(period);
        const tracking = results[1].window;
        expect(tracking.acquiring).toBe(false);
        // Echoes are searched for until shortly before the next ping
        // arrives, so the ping can be analysed about when that happens.
        const ready = tracking.start + tracking.length - period;
        expect(ready).toBeLessThan(1000 + period + 0.01 * fs);
        expect(tracking.length).toBeLessThan(results[0].window.length / 1.5);
    });

    it('follows a drifting latency', () => {
        // 6 frames per ping, as the resampler of a browser might do.
        const results = analyse(
            stream(40, (k) => 3000 - 6 * k),
            40
        );
        // Longer than a period: each ping's window holds the previous chirp.
        expect(results[0].valid).toBe(false);
        for (const [k, r] of results.entries()) {
            if (k < 1) {
                continue;
            }
            expect(r.valid).toBe(true);
            expect(r.latency).toBeCloseTo(3000 - 6 * (k - 1), 0);
            expect(
                Math.abs((r.distance as number) - ECHO_DISTANCE)
            ).toBeLessThan(0.004);
        }
    });

    it('drops a ping that was garbled, and carries on', () => {
        const results = analyse(
            stream(
                12,
                () => 1000,
                (k) => (k === 6 ? 0.2 : 1)
            ),
            12
        );
        expect(results.map((r) => r.valid)).toEqual(
            Array.from({ length: 12 }, (_, k) => k !== 6)
        );
        expect(results[7].window.acquiring).toBe(false);
    });

    it('searches afresh when the latency jumps', () => {
        const latency = (k: number) => (k < 8 ? 1000 : 2000);
        const results = analyse(stream(20, latency), 20);
        expect(results[7].valid).toBe(true);
        // Three pings without a direct path where it was expected ...
        expect(results.slice(8, 11).map((r) => r.valid)).toEqual([
            false,
            false,
            false,
        ]);
        // ... then found again, wherever in the period it is now.
        expect(results[11].window.acquiring).toBe(true);
        for (const r of results.slice(11)) {
            expect(r.valid).toBe(true);
            expect(r.latency).toBeCloseTo(2000, 0);
            expect(
                Math.abs((r.distance as number) - ECHO_DISTANCE)
            ).toBeLessThan(0.004);
        }
    });
});
