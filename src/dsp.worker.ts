// DSP worker: buffers mic samples, cuts out the recording for each ping and
// analyses it (highpass, matched filter, peak picking).

import { BANDS, type SonarConfig } from './config';
import {
    type AnalysisParams,
    analyzePing,
    highpassBiquad,
    nextPow2,
    speedOfSound,
} from './dsp';
import type { CaptureBlock, FromWorker, ToWorker } from './messages';

const STATS_INTERVAL_MS = 250;
/** Highpass cutoff relative to the lower chirp frequency. */
const HIGHPASS_RATIO = 0.7;
/** Target number of points in the envelope sent for display. */
const ENVELOPE_POINTS = 1000;

interface Job {
    chirp: Float32Array;
    params: AnalysisParams;
    /** Samples analysed per ping, starting at emitFrame. */
    windowLength: number;
}

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
let job: Job | null = null;
let pending: PendingPing[] = [];

function post(msg: FromWorker, transfer: Transferable[] = []) {
    self.postMessage(msg, { transfer });
}

function makeJob(config: SonarConfig, chirp: Float32Array): Job {
    const band = BANDS[config.band];
    const c = speedOfSound(config.temperature);
    const period = Math.round(config.interval * sampleRate);
    const maxLag = Math.ceil(((2 * config.maxRange) / c) * sampleRate);
    // At least two widths of the compressed pulse (≈ 1/bandwidth), so the
    // direct path's main lobe is never mistaken for an echo.
    const pulseWidth = Math.ceil((2 / (band.f1 - band.f0)) * sampleRate);
    const minLag = Math.ceil(((2 * config.minRange) / c) * sampleRate);
    return {
        chirp,
        // The device latency is unknown, so the direct path may arrive
        // anywhere within the ping period; its echo up to maxLag later.
        windowLength: period + maxLag + chirp.length,
        params: {
            highpass: highpassBiquad(sampleRate, HIGHPASS_RATIO * band.f0),
            directSearchEnd: period,
            blank: Math.max(minLag, pulseWidth),
            maxLag,
        },
    };
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
    if (!job) {
        return;
    }
    while (pending.length > 0) {
        const ping = pending[0];
        if (ping.emitFrame + job.windowLength > endFrame) {
            return; // not fully recorded yet
        }
        pending.shift();
        if (ping.emitFrame < endFrame - ring.length) {
            continue; // already overwritten
        }
        analyse(job, ping);
    }
}

function analyse(job: Job, ping: PendingPing) {
    const mask = ring.length - 1;
    const x = new Float32Array(job.windowLength);
    for (let i = 0; i < x.length; i++) {
        x[i] = ring[(ping.emitFrame + i) & mask];
    }
    const result = analyzePing(x, job.chirp, job.params);

    // Envelope for display: from slightly before the direct path to maxLag
    // after it, max-pooled so that narrow peaks survive.
    const { maxLag } = job.params;
    const start = Math.max(0, Math.floor(result.direct.index) - (maxLag >> 4));
    const end = Math.min(
        result.envelope.length,
        start + maxLag + (maxLag >> 4)
    );
    const step = Math.max(1, Math.ceil((end - start) / ENVELOPE_POINTS));
    const pooled = new Float32Array(Math.ceil((end - start) / step));
    for (let i = 0; i < pooled.length; i++) {
        let m = 0;
        for (
            let j = start + i * step;
            j < Math.min(end, start + (i + 1) * step);
            j++
        ) {
            m = Math.max(m, result.envelope[j]);
        }
        pooled[i] = m;
    }

    post(
        {
            type: 'echo',
            pingId: ping.pingId,
            direct: result.direct.index,
            directAmplitude: result.direct.amplitude,
            echo: result.echo?.index ?? null,
            echoAmplitude: result.echo?.amplitude ?? 0,
            noiseFloor: result.noiseFloor,
            envelope: pooled,
            envStart: start,
            envStep: step,
        },
        [pooled.buffer]
    );
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
            job = makeJob(msg.config, msg.chirp);
            pending = [];
            break;
        case 'ping':
            pending.push({ pingId: msg.pingId, emitFrame: msg.emitFrame });
            break;
    }
};
