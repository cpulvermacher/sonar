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
const resultLine = el<HTMLElement>('result');

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

let session: AudioSession | null = null;
let pingCount = 0;

function onWorkerMessage(msg: FromWorker) {
    if (!session) {
        return;
    }
    switch (msg.type) {
        case 'stats': {
            const secs = msg.framesReceived / session.ctx.sampleRate;
            status.textContent =
                `${session.ctx.sampleRate} Hz · mic ${msg.rmsDb.toFixed(1)} dBFS` +
                ` · ${secs.toFixed(1)} s captured · ${pingCount} pings`;
            break;
        }
        case 'echo': {
            const fs = session.ctx.sampleRate;
            // Samples of round-trip delay -> metres of one-way distance.
            const toMetres = speedOfSound(config.temperature) / fs / 2;
            estimator.push({
                distance:
                    msg.echo === null
                        ? null
                        : (msg.echo - msg.direct) * toMetres,
                sigma: msg.delaySigma * toMetres,
                snr: msg.echoSnr,
            });
            const est = estimator.estimate();

            const latencyMs = (msg.direct / fs) * 1000;
            let text = est
                ? `${est.distance.toFixed(3)} m ± ${(est.sigma * 1000).toFixed(1)} mm` +
                  ` (scatter ${(est.sigmaStat * 1000).toFixed(1)}, SNR model ${(est.sigmaModel * 1000).toFixed(2)},` +
                  ` sound speed ${(est.sigmaSound * 1000).toFixed(1)} mm;` +
                  ` ${est.accepted}/${est.window} pings)`
                : 'no echo';
            text +=
                ` · latency ${latencyMs.toFixed(2)} ms` +
                ` · SNR direct ${toDb(msg.directSnr).toFixed(1)} dB, echo ` +
                (msg.echo === null
                    ? '–'
                    : `${toDb(msg.echoSnr).toFixed(1)} dB`);
            resultLine.textContent = text;
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
            resultLine.textContent = '';
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
