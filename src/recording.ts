// Raw mic recordings of recent pings, saved as a JSON file so they can be
// analysed offline (e.g. replayed in tests). Sample arrays are stored as
// base64-encoded little-endian float32.

import type { SonarConfig } from './config';

const FORMAT = 'sonar-recording';
/**
 * Versions 1 and 2 stored a full ping period from emitFrame on, the peak
 * positions of the analysis then in use, and possibly a calibrated
 * background, which is not used any more.
 */
const VERSION = 3;

export interface RecordedPing {
    pingId: number;
    emitFrame: number;
    /** Context frame of samples[0]. */
    startFrame: number;
    /** Mic samples, exactly as analysed. */
    samples: Float32Array;
    /** The live analysis, for comparison: distance in m, if an echo was found. */
    distance: number | null;
}

export interface Recording {
    createdAt: string;
    userAgent: string;
    sampleRate: number;
    config: SonarConfig;
    chirp: Float32Array;
    pings: RecordedPing[];
}

interface PingFile extends Omit<RecordedPing, 'samples' | 'startFrame'> {
    /** Missing before version 3, where samples start at emitFrame. */
    startFrame?: number;
    samples: string;
}

interface RecordingFile extends Omit<Recording, 'chirp' | 'pings'> {
    format: typeof FORMAT;
    version: number;
    chirp: string;
    pings: PingFile[];
}

/** Keeps the most recent `capacity` pings. */
export class Recorder {
    private pings: RecordedPing[] = [];
    capacity: number;

    constructor(capacity: number) {
        this.capacity = capacity;
    }

    get size(): number {
        return this.pings.length;
    }

    push(ping: RecordedPing): void {
        this.pings.push(ping);
        while (this.pings.length > this.capacity) {
            this.pings.shift();
        }
    }

    clear(): void {
        this.pings = [];
    }

    snapshot(): RecordedPing[] {
        return [...this.pings];
    }
}

export function encodeRecording(rec: Recording): string {
    const file: RecordingFile = {
        format: FORMAT,
        version: VERSION,
        createdAt: rec.createdAt,
        userAgent: rec.userAgent,
        sampleRate: rec.sampleRate,
        config: rec.config,
        chirp: toBase64(rec.chirp),
        pings: rec.pings.map((p) => ({ ...p, samples: toBase64(p.samples) })),
    };
    return JSON.stringify(file);
}

export function decodeRecording(json: string): Recording {
    const file = JSON.parse(json) as RecordingFile;
    if (
        file.format !== FORMAT ||
        !(file.version >= 1 && file.version <= VERSION)
    ) {
        throw new Error('Not a sonar recording (or an unsupported version)');
    }
    return {
        createdAt: file.createdAt,
        userAgent: file.userAgent,
        sampleRate: file.sampleRate,
        config: file.config,
        chirp: fromBase64(file.chirp),
        pings: file.pings.map((p) => ({
            pingId: p.pingId,
            emitFrame: p.emitFrame,
            startFrame: p.startFrame ?? p.emitFrame,
            samples: fromBase64(p.samples),
            distance: p.distance ?? null,
        })),
    };
}

/** Chunk size for String.fromCharCode, to stay below argument limits. */
const CHUNK = 0x8000;

function toBase64(x: Float32Array): string {
    const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function fromBase64(s: string): Float32Array {
    const binary = atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer);
}

/**
 * The samples of `ping` for the frames [start, start + length); frames it
 * does not cover are silent.
 */
export function sliceRecorded(
    ping: RecordedPing,
    start: number,
    length: number
): Float32Array {
    const out = new Float32Array(length);
    const offset = start - ping.startFrame;
    const from = Math.max(0, -offset);
    const to = Math.min(length, ping.samples.length - offset);
    if (to > from) {
        out.set(ping.samples.subarray(offset + from, offset + to), from);
    }
    return out;
}
