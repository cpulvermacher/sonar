// DSP worker: buffers mic samples, and analyses each ping as soon as the
// samples it needs have arrived.

import { PingAnalyser } from './analyser';
import { nextPow2 } from './dsp';
import type { CaptureBlock, FromWorker, ToWorker } from './messages';

const STATS_INTERVAL_MS = 250;

interface PendingPing {
    pingId: number;
    emitFrame: number;
}

let sampleRate = 48000;
let ring = new Float32Array(0);
/** Frame index one past the newest sample in the ring. */
let endFrame = 0;
let framesReceived = 0;
let lastStats = 0;
let analyser: PingAnalyser | null = null;
let pending: PendingPing[] = [];

function post(msg: FromWorker, transfer: Transferable[] = []) {
    self.postMessage(msg, { transfer });
}

function onBlock(block: CaptureBlock) {
    const mask = ring.length - 1;
    const { startFrame, samples } = block;
    for (let i = 0; i < samples.length; i++) {
        ring[(startFrame + i) & mask] = samples[i];
    }
    endFrame = Math.max(endFrame, startFrame + samples.length);
    framesReceived += samples.length;

    processPending();
    postStats(samples);
}

function postStats(samples: Float32Array) {
    const now = performance.now();
    if (now - lastStats < STATS_INTERVAL_MS) {
        return;
    }
    lastStats = now;

    let sum = 0;
    for (const s of samples) {
        sum += s * s;
    }
    const rms = Math.sqrt(sum / samples.length);
    post({
        type: 'stats',
        framesReceived,
        rmsDb: 20 * Math.log10(rms + 1e-12),
    });
}

function processPending() {
    if (!analyser) {
        return;
    }
    while (pending.length > 0) {
        const ping = pending[0];
        // Depends on the previous ping's result, so not known earlier.
        const window = analyser.window(ping.emitFrame);
        if (window.start + window.length > endFrame) {
            return; // not fully recorded yet
        }
        pending.shift();
        if (window.start < endFrame - ring.length) {
            continue; // already overwritten
        }

        const mask = ring.length - 1;
        const x = new Float32Array(window.length);
        for (let i = 0; i < x.length; i++) {
            // Frames from before the capture started read as silence.
            const frame = window.start + i;
            x[i] = frame < 0 ? 0 : ring[frame & mask];
        }
        const result = analyser.process(ping.emitFrame, window, x);
        post(
            {
                type: 'echo',
                pingId: ping.pingId,
                emitFrame: ping.emitFrame,
                valid: result.valid,
                latency: result.latency,
                distance: result.distance,
                level: result.echo?.level ?? null,
                power: result.power,
                threshold: result.threshold,
                lagOffset: result.lagOffset,
                raw: x,
                rawStart: window.start,
                direct: result.direct,
            },
            [result.power.buffer, result.threshold.buffer, x.buffer]
        );
    }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
    const msg = e.data;
    switch (msg.type) {
        case 'init':
            sampleRate = msg.sampleRate;
            // About 2 s of history; a power of two so indices can be masked.
            ring = new Float32Array(nextPow2(2 * sampleRate));
            endFrame = 0;
            framesReceived = 0;
            msg.port.onmessage = (ev: MessageEvent<CaptureBlock>) =>
                onBlock(ev.data);
            break;
        case 'start':
            analyser = new PingAnalyser(msg.chirp, sampleRate, msg.config);
            pending = [];
            break;
        case 'ping':
            pending.push({ pingId: msg.pingId, emitFrame: msg.emitFrame });
            break;
    }
};
