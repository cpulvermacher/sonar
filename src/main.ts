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
import { SonarView } from './viz';
import './style.css';

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) {
        throw new Error(`missing #${id}`);
    }
    return node as T;
}

const button = el<HTMLButtonElement>('toggle');
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

            view.update({
                pingId: msg.pingId,
                envelope: msg.envelope,
                envStart: msg.envStart,
                envStep: msg.envStep,
                direct: msg.direct,
                echo: msg.echo,
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
            startPinging(session, config, (id) => {
                pingCount = id + 1;
            });
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
