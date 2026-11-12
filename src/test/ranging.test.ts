import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config';
import { makeChirp } from '../dsp';
import {
    ClutterFloor,
    echoThreshold,
    findEcho,
    Ranger,
    rangeProfile,
    rangingParams,
} from '../ranging';
import { delayed, mix, noise, sine } from './helpers';

const fs = 48000;
const config = { ...DEFAULT_CONFIG, interval: 0.25 };
const params = rangingParams(fs, config);
const mps = params.metresPerSample;

describe('rangingParams', () => {
    it('converts the configured ranges to lags', () => {
        expect(mps).toBeCloseTo(343.42 / fs / 2, 9);
        expect(params.minLag * mps).toBeGreaterThanOrEqual(config.blindRange);
        expect((params.minLag - 1) * mps).toBeLessThan(config.blindRange);
        // The offset is added afterwards, so it is not searched twice.
        expect(params.maxLag * mps + config.rangeOffset).toBeCloseTo(
            config.maxRange,
            2
        );
    });

    it('scales its time constants with the sample rate', () => {
        const double = rangingParams(2 * fs, config);
        expect(double.smooth).toBe(2 * params.smooth);
        expect(double.clusterBefore).toBe(2 * params.clusterBefore);
    });
});

describe('rangeProfile', () => {
    // A direct path of two arrivals, of which now one, now the other is the
    // stronger: the maximum jumps, the reference position should not.
    function cluster(first: number, second: number): Float64Array {
        const pw = new Float64Array(2000);
        for (let i = -3; i <= 3; i++) {
            pw[500 + i] = first * Math.exp(-i * i);
            pw[512 + i] = second * Math.exp(-i * i);
        }
        pw[900] = 0.5;
        return pw;
    }

    it('places the direct path at the centroid of its cluster', () => {
        const a = rangeProfile(cluster(1, 0.9), 0, 1000, params);
        const b = rangeProfile(cluster(0.9, 1), 0, 1000, params);
        expect(Math.abs(a.direct - b.direct)).toBeLessThan(1.5);
        expect(a.direct).toBeGreaterThan(500);
        expect(a.direct).toBeLessThan(512);
    });

    it('normalises the power to the direct cluster', () => {
        const a = rangeProfile(cluster(1, 0.9), 0, 1000, params);
        const louder = cluster(1, 0.9).map((v) => 100 * v);
        const b = rangeProfile(louder, 0, 1000, params);
        expect(b.amplitude).toBeCloseTo(10 * a.amplitude, 6);
        for (let l = 0; l < a.power.length; l++) {
            expect(b.power[l]).toBeCloseTo(a.power[l], 6);
        }
        // The single-sample spike at 900, spread by the smoothing.
        const lag = 900 - a.origin;
        expect(a.power[lag]).toBeGreaterThan(100 * a.power[lag + 20]);
        expect(a.power[lag]).toBe(a.power[lag + params.smooth]);
    });

    it('treats samples outside the recording as silence', () => {
        const pw = cluster(1, 0.9).subarray(0, 600);
        const profile = rangeProfile(pw, 0, 600, params);
        expect(profile.power.length).toBe(params.maxLag + 1);
        expect(profile.power[params.maxLag]).toBe(0);
    });
});

describe('ClutterFloor', () => {
    const options = { dilate: 2, leak: 1.1, maxDrop: 4 };

    it('starts as the running minimum of the first profile', () => {
        const floor = new ClutterFloor(options);
        expect(floor.ready).toBe(false);
        floor.update(Float32Array.from([8, 4, 6, 2, 3, 1, 5]));
        expect(floor.ready).toBe(true);
        expect(Array.from(floor.threshold(1))).toEqual(
            // ... each widened by two lags to either side.
            [8, 8, 8, 4, 4, 2, 2]
        );
    });

    it('follows the power down, but only so fast', () => {
        const floor = new ClutterFloor({ ...options, dilate: 0 });
        floor.update(Float32Array.from([16, 16]));
        floor.update(Float32Array.from([8, 1]));
        expect(Array.from(floor.threshold(1))).toEqual([8, 4]);
        floor.update(Float32Array.from([8, 1]));
        expect(Array.from(floor.threshold(1))).toEqual([8, 1]);
    });

    it('creeps up slowly under an echo that stays', () => {
        const floor = new ClutterFloor({ ...options, dilate: 0 });
        floor.update(Float32Array.from([1, 1]));
        for (let k = 0; k < 3; k++) {
            floor.update(Float32Array.from([100, 1.05]));
        }
        const [under, capped] = floor.threshold(1);
        expect(under).toBeCloseTo(1.1 ** 3, 5);
        expect(capped).toBeCloseTo(1.05, 5);
    });

    it('scales the threshold by the required excess', () => {
        const floor = new ClutterFloor({ ...options, dilate: 0 });
        floor.update(Float32Array.from([2, 1]));
        expect(Array.from(floor.threshold(5))).toEqual([10, 5]);
    });
});

describe('findEcho', () => {
    const n = params.maxLag + 1;
    const flat = () => new Float32Array(n).fill(1);
    function bump(power: Float32Array, at: number, height: number, width = 8) {
        for (let i = -width; i <= width; i++) {
            power[at + i] = Math.max(
                power[at + i],
                height * Math.exp(-((i / (width / 2)) ** 2))
            );
        }
    }
    const threshold = new Float32Array(n).fill(5);

    it('finds nothing below the threshold', () => {
        expect(findEcho(flat(), threshold, params)).toBeNull();
    });

    it('returns the nearest of several echoes, to a fraction of a lag', () => {
        const power = flat();
        bump(power, 200, 50);
        bump(power, 300, 500);
        // Shift the nearer one's peak by a fraction of a sample.
        power[199] *= 0.97;
        power[201] *= 1.03;
        const echo = findEcho(power, threshold, params);
        expect(echo?.lag).toBeGreaterThan(200);
        expect(echo?.lag).toBeLessThan(200.5);
        expect(echo?.level).toBe(50);
    });

    it('ignores what is too close or too far', () => {
        const power = flat();
        bump(power, params.minLag - 12, 50);
        expect(findEcho(power, threshold, params)).toBeNull();
        expect(
            findEcho(power, threshold, { ...params, maxLag: 100 })
        ).toBeNull();
    });

    it('ignores spikes narrower than an echo can be', () => {
        const power = flat();
        power[200] = 1000;
        expect(findEcho(power, threshold, params)).toBeNull();
    });

    it('skips a foothill, but not a first peak of similar height', () => {
        // Two overlapping bumps: one stretch above the threshold.
        const foothill = flat();
        bump(foothill, 200, 20, 10);
        bump(foothill, 212, 100, 10);
        expect(findEcho(foothill, threshold, params)?.lag).toBeCloseTo(212, 0);

        const twin = flat();
        bump(twin, 200, 60, 10);
        bump(twin, 212, 100, 10);
        expect(findEcho(twin, threshold, params)?.lag).toBeCloseTo(200, 0);
    });
});

describe('echoThreshold', () => {
    it('asks for the echo of a wall: 6 dB less per doubling of distance', () => {
        const clutter = new Float32Array(params.maxLag + 1);
        const threshold = echoThreshold(clutter, params);
        const lagAt = (d: number) => Math.round((d - config.rangeOffset) / mps);
        expect(threshold[lagAt(0.5)]).toBeCloseTo(
            10 ** (config.sensitivityDb / 10),
            5
        );
        expect(threshold[lagAt(1)] / threshold[lagAt(0.5)]).toBeCloseTo(
            0.25,
            2
        );
    });

    it('never goes below the clutter', () => {
        const clutter = new Float32Array(params.maxLag + 1).fill(7);
        expect(echoThreshold(clutter, params).every((t) => t === 7)).toBe(true);
    });
});

describe('Ranger', () => {
    const chirp = makeChirp(fs, 2000, 12000, 0.005);
    const n = 4000;
    const directAt = 1000;

    /** A ping with echoes given as [delay in samples, amplitude]. */
    function ping(echoes: [number, number][], seed = 1): Float32Array {
        const x = delayed(chirp, directAt, n);
        for (const [delay, amplitude] of echoes) {
            mix(x, delayed(chirp, directAt + delay, n), amplitude);
        }
        mix(x, sine(fs, 50, n), 0.3);
        mix(x, noise(n, 0.002, seed));
        return x;
    }
    const process = (ranger: Ranger, x: Float32Array) =>
        ranger.process(x, 500, 1500, true);

    it('measures an echo to a few millimetres, from the first ping', () => {
        const ranger = new Ranger(chirp, fs, config);
        const result = process(ranger, ping([[300.4, 0.1]]));
        expect(result.valid).toBe(true);
        expect(result.direct).toBeCloseTo(directAt, 0);
        const expected = 300.4 * mps + config.rangeOffset;
        expect(Math.abs((result.distance as number) - expected)).toBeLessThan(
            0.003
        );
    });

    it('finds no echo when there is none', () => {
        const ranger = new Ranger(chirp, fs, config);
        const result = process(ranger, ping([]));
        expect(result.valid).toBe(true);
        expect(result.echo).toBeNull();
        expect(result.distance).toBeNull();
        expect(result.threshold.length).toBe(result.power.length);
    });

    it('ignores an echo too weak to be a wall at its distance', () => {
        const ranger = new Ranger(chirp, fs, config);
        expect(process(ranger, ping([[300, 0.004]])).echo).toBeNull();
        // The same echo from much closer would be even weaker a reflector.
        expect(process(ranger, ping([[60, 0.004]])).echo).toBeNull();
    });

    describe("with a phone's smeared response", () => {
        // The direct path rings out over 100 samples: many arrivals in
        // close succession, each a little weaker.
        const tail: [number, number][] = Array.from({ length: 50 }, (_, k) => [
            2 * (k + 1),
            0.5 * Math.exp(-k / 8),
        ]);
        // Inside the tail, and stronger than it there, though weaker than
        // the tail is closer in.
        const wall: [number, number] = [60, 0.15];
        const wallDistance = 60 * mps + config.rangeOffset;

        it('does not take the tail for an echo', () => {
            const ranger = new Ranger(chirp, fs, config);
            for (let k = 0; k < 5; k++) {
                expect(process(ranger, ping(tail, k)).distance).toBeNull();
            }
        });

        it('finds a wall that comes into the tail', () => {
            const ranger = new Ranger(chirp, fs, config);
            process(ranger, ping(tail, 1));
            const result = process(ranger, ping([...tail, wall], 2));
            expect(
                Math.abs((result.distance as number) - wallDistance)
            ).toBeLessThan(0.02);
        });

        // (One that merges with the tail without a dip before it is only
        // found once it has moved; see the 20 cm recording in replay.test.)
        it('finds a wall that stands out of the tail from the first ping', () => {
            const ranger = new Ranger(chirp, fs, config);
            const result = process(ranger, ping([...tail, wall], 1));
            expect(
                Math.abs((result.distance as number) - wallDistance)
            ).toBeLessThan(0.02);
        });
    });

    it('rejects a ping whose direct path is much weaker than usual', () => {
        const ranger = new Ranger(chirp, fs, config);
        expect(process(ranger, ping([], 0)).valid).toBe(true);
        for (let k = 1; k < 4; k++) {
            expect(ranger.process(ping([], k), 500, 1500).valid).toBe(true);
        }
        const glitch = ping([], 9).map((v) => 0.5 * v);
        expect(ranger.process(glitch, 500, 1500).valid).toBe(false);
        // While searching, any level is accepted again ...
        expect(ranger.process(glitch, 500, 1500, true).valid).toBe(true);
        // ... but not silence or plain noise.
        expect(process(ranger, new Float32Array(n)).valid).toBe(false);
        expect(process(ranger, noise(n, 0.1)).valid).toBe(false);
    });
});
