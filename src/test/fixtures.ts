// Recordings from an Android phone (Firefox, 96 kHz, one ping every 0.25 s),
// trimmed by scripts/make-fixtures.ts to the stretch around the direct path,
// and a replay of them through the analysis as the worker runs it.

import { PingAnalyser } from '../analyser';
import { DEFAULT_CONFIG, type SonarConfig } from '../config';
import { type RecordedPing, sliceRecorded } from '../recording';
import { DistanceTracker } from '../tracker';

interface FixtureFile {
    sampleRate: number;
    interval: number;
    /** base64 float32 */
    chirp: string;
    scale: number;
    /** samples: base64 int16, to be multiplied by scale */
    pings: (Omit<RecordedPing, 'samples' | 'distance'> & {
        samples: string;
    })[];
}

export interface Fixture {
    sampleRate: number;
    config: SonarConfig;
    chirp: Float32Array;
    pings: RecordedPing[];
}

function bytes(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out.buffer;
}

export function decodeFixture(json: string): Fixture {
    const file = JSON.parse(json) as FixtureFile;
    return {
        sampleRate: file.sampleRate,
        config: { ...DEFAULT_CONFIG, interval: file.interval },
        chirp: new Float32Array(bytes(file.chirp)),
        pings: file.pings.map((p) => ({
            ...p,
            samples: Float32Array.from(
                new Int16Array(bytes(p.samples)),
                (s) => s * file.scale
            ),
            distance: null,
        })),
    };
}

export interface ReplayedPing {
    pingId: number;
    valid: boolean;
    /** This ping's echo distance in m, if any. */
    distance: number | null;
    /** The tracked distance after this ping, if any. */
    estimate: number | null;
    /** Probability that the tracked echo is the right one, if any. */
    confidence: number | null;
    /** Error (m) expected from tracking the wrong echo, if any. */
    peakError: number | null;
    /** Arrival of the direct path relative to the ping's emitFrame. */
    delay: number;
}

export function replay(fixture: Fixture): ReplayedPing[] {
    const { config } = fixture;
    const analyser = new PingAnalyser(
        fixture.chirp,
        fixture.sampleRate,
        config
    );
    const tracker = new DistanceTracker({
        interval: config.interval,
        soundSpeedRelError: 0,
    });
    return fixture.pings.map((ping) => {
        const window = analyser.window(ping.emitFrame);
        const x = sliceRecorded(ping, window.start, window.length);
        const result = analyser.process(ping.emitFrame, window, x);
        const estimate = tracker.push(
            result.valid ? result.distance : null,
            result.ambiguity ?? undefined
        );
        return {
            confidence: estimate?.peak.confidence ?? null,
            peakError: estimate
                ? estimate.peak.nearer + estimate.peak.farther
                : null,
            pingId: ping.pingId,
            valid: result.valid,
            distance: result.valid ? result.distance : null,
            estimate: estimate?.distance ?? null,
            delay: result.directFrame - ping.emitFrame,
        };
    });
}
