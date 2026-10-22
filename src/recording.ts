// Raw mic recordings of recent pings, saved as a JSON file so they can be
// analysed offline (e.g. replayed in tests). Sample arrays are stored as
// base64-encoded little-endian float32.

import type { SonarConfig } from './config';

const FORMAT = 'sonar-recording';
const VERSION = 1;

export interface RecordedPing {
    pingId: number;
    emitFrame: number;
    /** Mic samples from emitFrame on, exactly as analysed. */
    samples: Float32Array;
    /** The live analysis, for comparison: peak positions in samples. */
    direct: number;
    echo: number | null;
    echoSnr: number;
}

export interface Recording {
    createdAt: string;
    userAgent: string;
    sampleRate: number;
    config: SonarConfig;
    chirp: Float32Array;
    /** Background power profile in use (dsp.Background), if any. */
    background?: Float32Array | null;
    pings: RecordedPing[];
}

interface RecordingFile
    extends Omit<Recording, 'chirp' | 'background' | 'pings'> {
    format: typeof FORMAT;
    version: typeof VERSION;
    chirp: string;
    background?: string | null;
    pings: (Omit<RecordedPing, 'samples'> & { samples: string })[];
}

/** Keeps the most recent `capacity` pings. */
export class Recorder {
    private pings: RecordedPing[] = [];

    constructor(private readonly capacity: number) {}

    get size(): number {
        return this.pings.length;
    }

    push(ping: RecordedPing): void {
        this.pings.push(ping);
        if (this.pings.length > this.capacity) {
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
        background: rec.background ? toBase64(rec.background) : null,
        pings: rec.pings.map((p) => ({ ...p, samples: toBase64(p.samples) })),
    };
    return JSON.stringify(file);
}

export function decodeRecording(json: string): Recording {
    const file = JSON.parse(json) as RecordingFile;
    if (file.format !== FORMAT || file.version !== VERSION) {
        throw new Error('Not a sonar recording (or an unsupported version)');
    }
    return {
        createdAt: file.createdAt,
        userAgent: file.userAgent,
        sampleRate: file.sampleRate,
        config: file.config,
        chirp: fromBase64(file.chirp),
        background: file.background ? fromBase64(file.background) : null,
        pings: file.pings.map((p) => ({
            ...p,
            samples: fromBase64(p.samples),
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
