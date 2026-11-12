import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config';
import {
    decodeRecording,
    encodeRecording,
    Recorder,
    sliceRecorded,
} from '../recording';

const ping = (pingId: number) => ({
    pingId,
    emitFrame: pingId * 100,
    startFrame: pingId * 100 + 40,
    samples: new Float32Array(1),
    distance: null,
});

describe('Recorder', () => {
    it('keeps only the most recent pings', () => {
        const recorder = new Recorder(2);
        for (let id = 0; id < 5; id++) {
            recorder.push(ping(id));
        }
        expect(recorder.snapshot().map((p) => p.pingId)).toEqual([3, 4]);
        recorder.clear();
        expect(recorder.size).toBe(0);
    });

    it('applies a changed capacity from the next ping on', () => {
        const recorder = new Recorder(4);
        for (let id = 0; id < 4; id++) {
            recorder.push(ping(id));
        }
        recorder.capacity = 2;
        recorder.push(ping(4));
        expect(recorder.snapshot().map((p) => p.pingId)).toEqual([3, 4]);
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
                    startFrame: 130000,
                    samples,
                    distance: 0.515,
                },
            ],
        });
        const rec = decodeRecording(json);
        expect(rec.sampleRate).toBe(48000);
        expect(rec.config).toEqual(DEFAULT_CONFIG);
        expect(rec.chirp).toEqual(chirp);
        expect(rec.pings).toHaveLength(1);
        expect(rec.pings[0].samples).toEqual(samples);
        expect(rec.pings[0].startFrame).toBe(130000);
        expect(rec.pings[0].distance).toBe(0.515);
    });

    it('reads the older versions, whose samples start at emitFrame', () => {
        const samples = btoa(
            String.fromCharCode(...new Uint8Array(new Float32Array(3).buffer))
        );
        const rec = decodeRecording(
            JSON.stringify({
                format: 'sonar-recording',
                version: 1,
                sampleRate: 96000,
                config: {},
                chirp: samples,
                background: 'AAAA',
                pings: [
                    {
                        pingId: 2,
                        emitFrame: 48000,
                        samples,
                        direct: 16000.5,
                        echo: 16100,
                        echoSnr: 50,
                    },
                ],
            })
        );
        expect(rec.pings[0]).toEqual({
            pingId: 2,
            emitFrame: 48000,
            startFrame: 48000,
            samples: new Float32Array(3),
            distance: null,
        });
    });

    it('rejects other JSON', () => {
        expect(() => decodeRecording('{"foo": 1}')).toThrow();
        expect(() =>
            decodeRecording('{"format": "sonar-recording", "version": 99}')
        ).toThrow();
    });
});

describe('sliceRecorded', () => {
    const recorded = {
        ...ping(0),
        startFrame: 100,
        samples: Float32Array.from([1, 2, 3, 4]),
    };

    it('cuts out the frames asked for', () => {
        expect(Array.from(sliceRecorded(recorded, 101, 2))).toEqual([2, 3]);
    });

    it('pads with silence where the recording does not reach', () => {
        expect(Array.from(sliceRecorded(recorded, 98, 4))).toEqual([
            0, 0, 1, 2,
        ]);
        expect(Array.from(sliceRecorded(recorded, 102, 4))).toEqual([
            3, 4, 0, 0,
        ]);
        expect(Array.from(sliceRecorded(recorded, 500, 2))).toEqual([0, 0]);
        expect(Array.from(sliceRecorded(recorded, 0, 2))).toEqual([0, 0]);
    });
});
