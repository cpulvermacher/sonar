// DSP worker: buffers mic samples, cuts out the recording for each ping and
// analyses it (highpass, matched filter, peak picking).

import { chirpBand, type SonarConfig } from './config';
import {
    type AnalysisParams,
    analyzePing,
    type Background,
    type ComplexArray,
    delaySigma,
    highpassBiquad,
    makeBackground,
    nextPow2,
    peakSnr,
    rmsBandwidth,
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
    /** RMS bandwidth of the chirp in Hz, for the delay uncertainty. */
    bandwidth: number;
    params: AnalysisParams;
    /** Samples analysed per ping, starting at emitFrame. */
    windowLength: number;
}

interface Calibration {
    left: number;
    profiles: ComplexArray[];
    /** Sum of the per-ping noise power relative to the direct peak. */
    noisePower: number;
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
let background: Background | null = null;
let calibration: Calibration | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []) {
    self.postMessage(msg, { transfer });
}

function makeJob(config: SonarConfig, chirp: Float32Array): Job {
    const band = chirpBand(config);
    const c = speedOfSound(config.temperature);
    const period = Math.round(config.interval * sampleRate);
    const maxLag = Math.ceil(((2 * config.maxRange) / c) * sampleRate);
    // At least two widths of the compressed pulse (≈ 1/bandwidth), so the
    // direct path's main lobe is never mistaken for an echo.
    const pulseWidth = Math.ceil((2 / (band.f1 - band.f0)) * sampleRate);
    const minLag = Math.ceil(((2 * config.minRange) / c) * sampleRate);
    return {
        chirp,
        bandwidth: rmsBandwidth(chirp, sampleRate),
        // The device latency is unknown, so the direct path may arrive
        // anywhere within the ping period; its echo up to maxLag later.
        windowLength: period + maxLag + chirp.length,
        params: {
            highpass: highpassBiquad(sampleRate, HIGHPASS_RATIO * band.f0),
            directSearchEnd: period,
            blank: Math.max(minLag, pulseWidth),
            maxLag,
            // Envelope amplitudes, so dB / 20.
            minProminence: 10 ** (config.minEchoProminenceDb / 20),
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
    const result = analyzePing(x, job.chirp, { ...job.params, background });
    const { maxLag } = job.params;
    if (calibration) {
        calibrate(calibration, result, job.params.blank);
    }

    // Envelope for display (with the background removed): from slightly
    // before the direct path to maxLag after it, max-pooled so that narrow
    // peaks survive.
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
            m = Math.max(m, result.searched[j]);
        }
        pooled[i] = m;
    }

    const directSnr = peakSnr(result.direct.amplitude, result.noiseFloor);
    const echoSnr = result.echo
        ? peakSnr(result.echo.amplitude, result.noiseFloor)
        : 0;
    // Both peak positions are uncertain; their errors add in quadrature.
    const sigma = Math.hypot(
        delaySigma(directSnr, job.bandwidth),
        delaySigma(echoSnr, job.bandwidth)
    );

    post(
        {
            type: 'echo',
            pingId: ping.pingId,
            emitFrame: ping.emitFrame,
            direct: result.direct.index,
            directSnr,
            echo: result.echo?.index ?? null,
            echoSnr,
            candidates: result.candidates,
            delaySigma: sigma * sampleRate,
            noiseFloor: result.noiseFloor,
            envelope: pooled,
            envStart: start,
            envStep: step,
            raw: x,
        },
        [pooled.buffer, x.buffer]
    );
}

function calibrate(
    cal: Calibration,
    result: ReturnType<typeof analyzePing>,
    start: number
) {
    cal.profiles.push(result.profile);
    // Mean noise power from the median of a Rayleigh-distributed envelope.
    cal.noisePower +=
        (result.noiseFloor / result.direct.amplitude) ** 2 / Math.LN2;
    cal.left--;
    if (cal.left > 0) {
        post({ type: 'calibration', left: cal.left, background: null });
        return;
    }
    calibration = null;
    background = makeBackground(
        cal.profiles,
        cal.noisePower / cal.profiles.length,
        start
    );
    post({
        type: 'calibration',
        left: 0,
        background: { re: background.re.slice(), im: background.im.slice() },
    });
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
        case 'calibrate':
            calibration = { left: msg.pings, profiles: [], noisePower: 0 };
            break;
        case 'background':
            background = msg.background;
            break;
    }
};
