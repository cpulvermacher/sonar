// Trims recordings saved from the app (sonar-*.json, not in git) down to
// test fixtures: of every ping only the stretch around the direct path that
// the analysis looks at, as 16-bit samples. The format is read by
// src/test/fixtures.ts.
//
//   node scripts/make-fixtures.ts
//
// Recordings of format version 1 and 2 only (a full ping period per ping,
// with the direct path's position); newer ones are small enough as they are.

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Samples kept before and after the recorded direct path (at 96 kHz). After
 * it: the 10 m searched at 4 pings/s, a chirp, and the analyser's tolerance
 * for latency drift.
 */
const BEFORE = 300;
const AFTER = 8000;

/** Recording → fixture name, and how many pings to keep (default: all). */
const SOURCES: [string, string, number?][] = [
    ['sonar-1freespace.json', 'freespace'],
    ['sonar-2wall20cm.json', 'wall20cm'],
    // Nothing moves in this one; half of it is enough.
    ['sonar-3wall50cm.json', 'wall50cm', 20],
    ['sonar-4hand20cm.json', 'hand20cm'],
    ['sonar-5handopen.json', 'handopen'],
    ['sonar-sweepfrom2mto0.json', 'sweep'],
];

function decode(base64: string): Float32Array {
    const bytes = Buffer.from(base64, 'base64');
    return new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
    );
}

for (const [source, name, keep] of SOURCES) {
    const file = JSON.parse(readFileSync(source, 'utf8'));
    const pings = file.pings.slice(0, keep).map(
        (p: {
            pingId: number;
            emitFrame: number;
            direct: number;
            samples: string;
        }) => {
            const samples = decode(p.samples);
            const from = Math.max(0, Math.floor(p.direct) - BEFORE);
            const to = Math.min(samples.length, Math.floor(p.direct) + AFTER);
            return {
                pingId: p.pingId,
                emitFrame: p.emitFrame,
                startFrame: p.emitFrame + from,
                samples: samples.subarray(from, to),
            };
        }
    );
    let peak = 0;
    for (const p of pings) {
        for (const s of p.samples) {
            peak = Math.max(peak, Math.abs(s));
        }
    }
    const scale = peak / 32767;
    const fixture = {
        source,
        sampleRate: file.sampleRate,
        interval: file.config.interval,
        chirp: file.chirp,
        /** samples are int16, to be multiplied by this. */
        scale,
        pings: pings.map((p: (typeof pings)[number]) => ({
            ...p,
            samples: Buffer.from(
                Int16Array.from(p.samples, (s: number) => Math.round(s / scale))
                    .buffer
            ).toString('base64'),
        })),
    };
    const path = `src/test/fixtures/${name}.json`;
    writeFileSync(path, JSON.stringify(fixture));
    console.log(`${path}: ${pings.length} pings`);
}
