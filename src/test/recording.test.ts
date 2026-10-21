import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config';
import { decodeRecording, encodeRecording, Recorder } from '../recording';

describe('Recorder', () => {
    it('keeps only the most recent pings', () => {
        const recorder = new Recorder(2);
        for (let id = 0; id < 5; id++) {
            recorder.push({
                pingId: id,
                emitFrame: id * 100,
                samples: new Float32Array(1),
                direct: 0,
                echo: null,
                echoSnr: 0,
            });
        }
        expect(recorder.snapshot().map((p) => p.pingId)).toEqual([3, 4]);
        recorder.clear();
        expect(recorder.size).toBe(0);
    });
});

describe('recording file', () => {
    it('round-trips samples exactly', () => {
        // Large enough to need several String.fromCharCode chunks; a
        // subarray, to check that byteOffset is respected.
        const backing = Float32Array.from(
            { length: 30001 },
            (_, i) => Math.sin(i) * 0.7
        );
        const samples = backing.subarray(1);
        const chirp = Float32Array.from([0, 0.5, -0.25, 1e-7, -1]);
        const json = encodeRecording({
            createdAt: '2026-10-21T20:00:00.000Z',
            userAgent: 'test',
            sampleRate: 48000,
            config: DEFAULT_CONFIG,
            chirp,
            pings: [
                {
                    pingId: 7,
                    emitFrame: 123456,
                    samples,
                    direct: 1000.25,
                    echo: 1500.5,
                    echoSnr: 99,
                },
            ],
        });
        const rec = decodeRecording(json);
        expect(rec.sampleRate).toBe(48000);
        expect(rec.config).toEqual(DEFAULT_CONFIG);
        expect(rec.chirp).toEqual(chirp);
        expect(rec.pings).toHaveLength(1);
        expect(rec.pings[0].samples).toEqual(samples);
        expect(rec.pings[0].echo).toBe(1500.5);
    });

    it('rejects other JSON', () => {
        expect(() => decodeRecording('{"foo": 1}')).toThrow();
    });
});
