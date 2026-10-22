// Background removal on real recordings from an Android phone (Firefox,
// 96 kHz), trimmed to the part around the direct path. The phone's own
// ringing produces a spurious "echo" at about 0.17 m.
import { describe, expect, it } from 'vitest';
import { BANDS, DEFAULT_CONFIG } from '../config';
import {
    type AnalysisParams,
    analyzePing,
    directProfile,
    highpassBiquad,
    makeBackground,
    peakSnr,
    removeBackground,
    speedOfSound,
} from '../dsp';
import { decodeRecording, type Recording } from '../recording';
import freespaceJson from './fixtures/freespace.json?raw';
import hand20Json from './fixtures/hand20cm.json?raw';
import wall50Json from './fixtures/wall50cm.json?raw';

const freespace = decodeRecording(freespaceJson);
const wall50 = decodeRecording(wall50Json);
const hand20 = decodeRecording(hand20Json);

// As in the worker's makeJob. The recordings predate some settings.
const config = { ...DEFAULT_CONFIG, ...freespace.config };
const fs = freespace.sampleRate;
const band = BANDS[config.band];
const c = speedOfSound(config.temperature);
const metresPerSample = c / fs / 2;
const maxLag = Math.ceil(((2 * config.maxRange) / c) * fs);
const params: AnalysisParams = {
    highpass: highpassBiquad(fs, 0.7 * band.f0),
    // The fixtures start 400 samples before the direct path.
    directSearchEnd: 1000,
    blank: Math.max(
        Math.ceil(((2 * config.minRange) / c) * fs),
        Math.ceil((2 / (band.f1 - band.f0)) * fs)
    ),
    maxLag,
    minProminence: 10 ** (config.minEchoProminenceDb / 20),
};
const margin = 10 ** (config.backgroundMarginDb / 10);

function calibrate(rec: Recording): Float32Array {
    let noisePower = 0;
    const profiles = rec.pings.map((p) => {
        const r = analyzePing(p.samples, rec.chirp, params);
        noisePower += (r.noiseFloor / r.direct.amplitude) ** 2 / Math.LN2;
        return directProfile(
            r.envelope,
            Math.round(r.direct.index),
            maxLag + 1
        );
    });
    return makeBackground(profiles, noisePower / profiles.length, params.blank);
}

/** Per ping: distance in m of an echo that passes the SNR threshold, or null. */
function distances(rec: Recording, power: Float32Array | null) {
    return rec.pings.map((p) => {
        const r = analyzePing(p.samples, rec.chirp, {
            ...params,
            background: power && { power, margin },
        });
        if (
            !r.echo ||
            10 * Math.log10(peakSnr(r.echo.amplitude, r.noiseFloor)) <
                config.minEchoSnrDb
        ) {
            return null;
        }
        return (r.echo.index - r.direct.index) * metresPerSample;
    });
}

const background = calibrate(freespace);

describe('background calibration', () => {
    it('covers only the near range where the phone rings', () => {
        const range = background.length * metresPerSample;
        expect(range).toBeGreaterThan(0.25);
        expect(range).toBeLessThan(1);
    });

    it('never touches the direct path or the blanked range', () => {
        const env = Float32Array.from({ length: 50 }, () => 1);
        const out = removeBackground(env, 10, 5, {
            power: new Float32Array(20).fill(1),
            margin: 4,
        });
        expect(Array.from(out.subarray(0, 15))).toEqual(Array(15).fill(1));
        expect(Array.from(out.subarray(15, 30))).toEqual(Array(15).fill(0));
        expect(Array.from(out.subarray(30))).toEqual(Array(20).fill(1));
    });
});

describe('echo picking on recordings', () => {
    it('without a background, picks the ringing instead of a wall at 50 cm', () => {
        for (const d of distances(wall50, null)) {
            expect(d).not.toBeNull();
            expect(d).toBeLessThan(0.25);
        }
    });

    it('with the background, finds the wall at 50 cm in every ping', () => {
        // The phone reads about 4 cm short; see the offset calibration.
        for (const d of distances(wall50, background)) {
            expect(d).toBeGreaterThan(0.44);
            expect(d).toBeLessThan(0.48);
        }
    });

    it('with the background, finds a hand at about 20 cm', () => {
        const found = distances(hand20, background).filter(
            (d) => d !== null && d > 0.2 && d < 0.3
        );
        expect(found.length).toBeGreaterThanOrEqual(6);
    });
});
