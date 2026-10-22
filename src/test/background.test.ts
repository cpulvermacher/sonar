// Background removal on a real recording from an Android phone (Firefox,
// 96 kHz), trimmed to the part around the direct path: the phone held in
// hand and moved from about 1.4 m away from a wall to touching it, one ping
// every 0.25 s. The phone's own clutter produces a spurious "echo" at about
// 0.17 m that is stronger than the wall.
import { describe, expect, it } from 'vitest';
import { BANDS, DEFAULT_CONFIG } from '../config';
import {
    type AnalysisParams,
    analyzePing,
    type Background,
    highpassBiquad,
    makeBackground,
    removeBackground,
    speedOfSound,
} from '../dsp';
import { decodeRecording } from '../recording';
import sweepJson from './fixtures/sweep-to-wall.json?raw';

const sweep = decodeRecording(sweepJson);

// As in the worker's makeJob.
const config = { ...DEFAULT_CONFIG, ...sweep.config };
const fs = sweep.sampleRate;
const band = BANDS[config.band];
const c = speedOfSound(config.temperature);
const metresPerSample = c / fs / 2;
const params: AnalysisParams = {
    highpass: highpassBiquad(fs, 0.7 * band.f0),
    // The fixture starts 400 samples before the direct path.
    directSearchEnd: 1000,
    blank: Math.max(
        Math.ceil(((2 * config.minRange) / c) * fs),
        Math.ceil((2 / (band.f1 - band.f0)) * fs)
    ),
    maxLag: Math.ceil(((2 * config.maxRange) / c) * fs),
    minProminence: 10 ** (config.minEchoProminenceDb / 20),
};

/** Pings with the wall still beyond 1.3 m, used for calibration. */
const CALIBRATION = 8;
/** Pings while the wall comes from about 0.95 m to 0.3 m. */
const APPROACH = sweep.pings.slice(9, 21);

function calibrate(): Background {
    const pings = sweep.pings.slice(0, CALIBRATION);
    let noisePower = 0;
    const profiles = pings.map((p) => {
        const r = analyzePing(p.samples, sweep.chirp, params);
        noisePower += (r.noiseFloor / r.direct.amplitude) ** 2 / Math.LN2;
        return r.profile;
    });
    return makeBackground(profiles, noisePower / pings.length, params.blank);
}

/**
 * Distance in m of the echo, or null. No SNR threshold: in the trimmed
 * fixture the noise floor (the envelope median) is mostly clutter, so SNRs
 * come out about 20 dB lower than in the full window the app analyses.
 */
function distance(samples: Float32Array, background: Background | null) {
    const r = analyzePing(samples, sweep.chirp, { ...params, background });
    return r.echo && (r.echo.index - r.direct.index) * metresPerSample;
}

const background = calibrate();

describe('background calibration', () => {
    it('covers only the near range of the phone itself', () => {
        const range = background.re.length * metresPerSample;
        expect(range).toBeGreaterThan(0.2);
        expect(range).toBeLessThan(1);
    });

    it('subtracts the background scaled by the direct peak, after the blanked range', () => {
        const bg = {
            re: Float32Array.from({ length: 20 }, (_, j) => Math.cos(j)),
            im: Float32Array.from({ length: 20 }, (_, j) => Math.sin(j)),
        };
        // The direct peak at d = 10 is 2j; from then on exactly 2j · bg.
        const re = new Float64Array(50).fill(3);
        const im = new Float64Array(50);
        for (let j = 0; j < 20; j++) {
            re[10 + j] = -2 * bg.im[j];
            im[10 + j] = 2 * bg.re[j];
        }
        const env = Float32Array.from(re, (r, i) => Math.hypot(r, im[i]));
        const out = removeBackground(env, { re, im }, 10, 5, bg);
        expect(Array.from(out.subarray(0, 15))).toEqual(
            Array.from(env.subarray(0, 15))
        );
        for (const v of out.subarray(15, 30)) {
            expect(v).toBeCloseTo(0, 6);
        }
        expect(Array.from(out.subarray(30))).toEqual(Array(20).fill(3));
    });
});

describe('echo picking on the sweep', () => {
    it('without a background, picks the clutter instead of the wall', () => {
        for (const p of APPROACH) {
            const d = distance(p.samples, null);
            expect(d).toBeGreaterThan(0.15);
            expect(d).toBeLessThan(0.19);
        }
    });

    it('with the background, follows the wall in', () => {
        const ds = APPROACH.map((p) => distance(p.samples, background));
        for (const d of ds) {
            expect(d).not.toBeNull();
            expect(d).toBeGreaterThan(0.25);
        }
        const found = ds as number[];
        expect(found[0]).toBeGreaterThan(0.85);
        expect(found[found.length - 1]).toBeLessThan(0.5);
        // Moved by hand, about 5 cm per ping; allow some jitter.
        for (let k = 1; k < found.length; k++) {
            expect(found[k]).toBeLessThan(found[k - 1] + 0.07);
        }
    });
});
