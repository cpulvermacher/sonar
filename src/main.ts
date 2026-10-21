import {
    type AudioSession,
    closeAudio,
    openAudio,
    startPinging,
} from './audio';
import { DEFAULT_CONFIG } from './config';
import { speedOfSound } from './dsp';
import { DistanceEstimator } from './estimate';
import type { FromWorker } from './messages';
import { encodeRecording, Recorder } from './recording';
import { SonarView } from './viz';
import './style.css';

/** Pings kept for "Save recording" (10 s at the default interval). */
const RECORDING_PINGS = 40;

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) {
        throw new Error(`missing #${id}`);
    }
    return node as T;
}

const button = el<HTMLButtonElement>('toggle');
const saveButton = el<HTMLButtonElement>('save');
const status = el<HTMLElement>('status');
const errorBox = el<HTMLElement>('error');

/** Power ratio to dB. */
const toDb = (ratio: number) => 10 * Math.log10(ratio);

const config = DEFAULT_CONFIG;
const estimator = new DistanceEstimator({
    window: config.averagePings,
    minSnrDb: config.minEchoSnrDb,
    outlierSigmas: 3,
    minAccepted: 3,
    // c = 331.3 + 0.606·T, so dc/dT = 0.606 m/s per °C.
    soundSpeedRelError:
        (0.606 * config.temperatureSigma) / speedOfSound(config.temperature),
});
const view = new SonarView(config, {
    distance: el('distance'),
    sigma: el('sigma'),
    details: el('details'),
    ascan: el('ascan'),
    ascanTip: el('ascan-tip'),
    echogram: el('echogram'),
    echogramTip: el('echogram-tip'),
    table: el('pings'),
});

let session: AudioSession | null = null;
let pingCount = 0;

// Kept after Stop, so a recording can still be saved.
const recorder = new Recorder(RECORDING_PINGS);
let recordingInfo: { sampleRate: number; chirp: Float32Array } | null = null;

function onWorkerMessage(msg: FromWorker) {
    if (!session) {
        return;
    }
    switch (msg.type) {
        case 'stats': {
            status.textContent =
                `${session.ctx.sampleRate} Hz · mic ${msg.rmsDb.toFixed(1)} dBFS` +
                ` · ${pingCount} pings`;
            break;
        }
        case 'echo': {
            const fs = session.ctx.sampleRate;
            // Samples of round-trip delay -> metres of one-way distance.
            const metresPerSample = speedOfSound(config.temperature) / fs / 2;
            const distance =
                msg.echo === null
                    ? null
                    : (msg.echo - msg.direct) * metresPerSample;
            const sigma = msg.delaySigma * metresPerSample;
            estimator.push({ distance, sigma, snr: msg.echoSnr });
            recorder.push({
                pingId: msg.pingId,
                emitFrame: msg.emitFrame,
                samples: msg.raw,
                direct: msg.direct,
                echo: msg.echo,
                echoSnr: msg.echoSnr,
            });
            saveButton.disabled = false;

            view.update({
                pingId: msg.pingId,
                envelope: msg.envelope,
                envStart: msg.envStart,
                envStep: msg.envStep,
                noiseFloor: msg.noiseFloor,
                direct: msg.direct,
                echo: msg.echo,
                candidates: msg.candidates,
                metresPerSample,
                distance,
                sigma,
                echoSnrDb: msg.echo === null ? null : toDb(msg.echoSnr),
                latencyMs: (msg.direct / fs) * 1000,
                estimate: estimator.estimate(),
            });
            break;
        }
    }
}

function setRunning(running: boolean) {
    button.textContent = running ? 'Stop' : 'Start';
    button.setAttribute('aria-pressed', String(running));
}

button.addEventListener('click', async () => {
    button.disabled = true;
    errorBox.textContent = '';
    try {
        if (session) {
            const s = session;
            session = null;
            await closeAudio(s);
            status.textContent = 'Stopped';
            setRunning(false);
        } else {
            status.textContent = 'Starting…';
            session = await openAudio(onWorkerMessage);
            pingCount = 0;
            estimator.reset();
            view.reset();
            recorder.clear();
            saveButton.disabled = true;
            const chirp = startPinging(session, config, (id) => {
                pingCount = id + 1;
            });
            recordingInfo = { sampleRate: session.ctx.sampleRate, chirp };
            status.textContent = `${session.ctx.sampleRate} Hz`;
            setRunning(true);
        }
    } catch (err) {
        session = null;
        setRunning(false);
        status.textContent = 'Stopped';
        errorBox.textContent = err instanceof Error ? err.message : String(err);
    } finally {
        button.disabled = false;
    }
});

saveButton.addEventListener('click', () => {
    if (!recordingInfo || recorder.size === 0) {
        return;
    }
    const now = new Date();
    const json = encodeRecording({
        createdAt: now.toISOString(),
        userAgent: navigator.userAgent,
        sampleRate: recordingInfo.sampleRate,
        config,
        chirp: recordingInfo.chirp,
        pings: recorder.snapshot(),
    });
    const url = URL.createObjectURL(
        new Blob([json], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    // Local time, e.g. sonar-2026-10-21T22-37-57.json
    const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 19)
        .replace(/:/g, '-');
    link.download = `sonar-${stamp}.json`;
    link.click();
    // Give the download a moment to start before releasing the data.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
});
