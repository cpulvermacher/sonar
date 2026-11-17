import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, maxRange } from '../config';
import { makeChirp } from '../dsp';
import {
    type Candidate,
    ClutterFloor,
    chooseEcho,
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
            maxRange(config),
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
        bump(power, 300, 100);
        // Shift the nearer one's peak by a fraction of a sample.
        power[199] *= 0.97;
        power[201] *= 1.03;
        const echo = findEcho(power, threshold, params);
        expect(echo?.lag).toBeGreaterThan(200);
        expect(echo?.lag).toBeLessThan(200.5);
        expect(echo?.level).toBe(50);
    });

    it('passes over a marginal near echo in front of a much clearer one', () => {
        // 1.5 dB above the threshold of 5, against 20 dB.
        const power = flat();
        bump(power, 200, 7);
        bump(power, 300, 500);
        expect(findEcho(power, threshold, params)?.lag).toBeCloseTo(300, 0);
        // On its own, it is reported.
        const alone = flat();
        bump(alone, 200, 7);
        expect(findEcho(alone, threshold, params)?.lag).toBeCloseTo(200, 0);
    });

    it('always takes the nearest where the clutter does not set the threshold', () => {
        const power = flat();
        bump(power, 200, 7);
        bump(power, 300, 500);
        // The clutter is far below the threshold: nothing of the phone's
        // own that could be fluctuating there.
        const clutter = new Float32Array(n).fill(0.1);
        expect(findEcho(power, threshold, params, clutter)?.lag).toBeCloseTo(
            200,
            0
        );
        // Only around the near one does it reach the threshold.
        clutter.fill(5, 150, 250);
        expect(findEcho(power, threshold, params, clutter)?.lag).toBeCloseTo(
            300,
            0
        );
    });

    it('can be set to always take the nearest', () => {
        const power = flat();
        bump(power, 200, 7);
        bump(power, 300, 500);
        bump(power, 400, 400);
        const nearest = rangingParams(fs, { ...config, echoChoice: 'nearest' });
        expect(findEcho(power, threshold, nearest)?.lag).toBeCloseTo(200, 0);
        // Otherwise, of the two clear ones, still the nearer.
        expect(findEcho(power, threshold, params)?.lag).toBeCloseTo(300, 0);
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

describe('chooseEcho', () => {
    const candidate = (
        lag: number,
        marginDb: number,
        motion: Candidate['motion'] = 'unknown',
        inClutter = false
    ): Candidate => ({
        lag,
        level: 1,
        margin: 10 ** (marginDb / 10),
        inClutter,
        motion,
    });

    it('prefers a moving echo to a slightly clearer one that stays put', () => {
        const pick = (nearDb: number) =>
            chooseEcho(
                [candidate(200, nearDb, 'still'), candidate(300, 8, 'moving')],
                params
            )?.lag;
        expect(pick(10)).toBe(300);
        // Not to one that is clearer by more than motionBonusDb (3 dB).
        expect(pick(12)).toBe(200);
    });

    it('needs to know that the nearer echo stays put', () => {
        // It has only just appeared: that may be the thing moving in.
        const echo = chooseEcho(
            [candidate(200, 10, 'unknown'), candidate(300, 8, 'moving')],
            params
        );
        expect(echo?.lag).toBe(200);
    });

    it('takes the nearest of the moving echoes', () => {
        const echo = chooseEcho(
            [
                candidate(200, 6, 'still'),
                candidate(300, 5, 'moving'),
                candidate(400, 15, 'moving'),
            ],
            params
        );
        expect(echo?.lag).toBe(300);
    });

    it('does not let a faint moving echo replace a clear one', () => {
        const echo = chooseEcho(
            [
                candidate(200, 6, 'still'),
                candidate(300, 0.5, 'moving'),
                candidate(400, 15, 'moving'),
            ],
            params
        );
        expect(echo?.lag).toBe(200);
    });

    it('keeps a weak echo in the clutter that moves', () => {
        // Passed over while it stays put, like a fluctuation of the
        // phone's own response; a hand that moves is not one.
        const pick = (motion: Candidate['motion']) =>
            chooseEcho(
                [candidate(100, 2, motion, true), candidate(300, 10, 'still')],
                params
            )?.lag;
        expect(pick('still')).toBe(300);
        expect(pick('moving')).toBe(100);
    });

    it('ignores motion when set to the nearest', () => {
        const nearest = rangingParams(fs, { ...config, echoChoice: 'nearest' });
        const echo = chooseEcho(
            [candidate(200, 3, 'still'), candidate(300, 20, 'moving')],
            nearest
        );
        expect(echo?.lag).toBe(200);
    });

    describe('ambiguity', () => {
        it('is none for a single echo', () => {
            const echo = chooseEcho([candidate(200, 10)], params);
            expect(echo?.ambiguity).toEqual({
                confidence: 1,
                nearer: 0,
                farther: 0,
                rival: null,
            });
        });

        it('is small with a much weaker echo behind', () => {
            const echo = chooseEcho(
                [candidate(200, 20), candidate(300, 2)],
                params
            );
            expect(echo?.ambiguity.confidence).toBeGreaterThan(0.99);
            expect(echo?.ambiguity.farther).toBeLessThan(1);
        });

        it('grows as the echo behind gets clearer', () => {
            const farther = (db: number) =>
                chooseEcho([candidate(200, 5), candidate(300, db)], params)
                    ?.ambiguity.farther as number;
            expect(farther(10)).toBeGreaterThan(farther(5));
            expect(farther(15)).toBeGreaterThan(farther(10));
            // The nearer one is still reported, but is no better a guess:
            // even odds, so half of the 100 lags between them.
            const echo = chooseEcho(
                [candidate(200, 5), candidate(300, 30)],
                params
            );
            expect(echo?.lag).toBe(200);
            expect(echo?.ambiguity.confidence).toBeCloseTo(0.5, 9);
            expect(echo?.ambiguity.farther).toBeCloseTo(50, 9);
            expect(echo?.ambiguity.nearer).toBe(0);
            expect(echo?.ambiguity.rival).toBe(300);
        });

        it('counts an echo that was passed over as an error towards the phone', () => {
            // 7 dB weaker, with 6 dB allowed: passed over by 1 dB.
            const echo = chooseEcho(
                [candidate(100, 3, 'unknown', true), candidate(300, 10)],
                params
            );
            expect(echo?.lag).toBe(300);
            const odds = 10 ** -0.1;
            expect(echo?.ambiguity.confidence).toBeCloseTo(1 / (1 + odds), 6);
            expect(echo?.ambiguity.nearer).toBeCloseTo(
                (200 * odds) / (1 + odds),
                4
            );
            expect(echo?.ambiguity.farther).toBe(0);
        });

        it('is larger when the choice went against a clearer echo for its motion', () => {
            const confidence = (motion: Candidate['motion']) =>
                chooseEcho(
                    [candidate(200, 9, 'still'), candidate(300, 8, motion)],
                    params
                )?.ambiguity.confidence as number;
            // 200 is reported and likely right, or 300 is and 200 a rival.
            expect(confidence('still')).toBeGreaterThan(0.9);
            expect(confidence('moving')).toBeLessThan(0.6);
        });
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
    const directAt = 1000;
    // Covers the whole range searched: where the signal stopped, the hum
    // would stop abruptly and look like an echo.
    const n = directAt + params.maxLag + 2 * chirp.length;

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
