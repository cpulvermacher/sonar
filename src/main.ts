import {
    type AudioSession,
    closeAudio,
    openAudio,
    startPinging,
} from './audio';
import { DEFAULT_CONFIG } from './config';
import { speedOfSound } from './dsp';
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

const toDb = (ratio: number) => 20 * Math.log10(ratio);

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
            const latencyMs = (msg.direct / fs) * 1000;
            let text =
                `ping ${msg.pingId}: direct at ${latencyMs.toFixed(2)} ms` +
                ` (SNR ${toDb(msg.directAmplitude / msg.noiseFloor).toFixed(1)} dB)`;
            if (msg.echo !== null) {
                const dt = (msg.echo - msg.direct) / fs;
                const distance =
                    (dt * speedOfSound(DEFAULT_CONFIG.temperature)) / 2;
                text +=
                    ` · echo +${(dt * 1000).toFixed(3)} ms ≈ ${distance.toFixed(3)} m` +
                    ` (SNR ${toDb(msg.echoAmplitude / msg.noiseFloor).toFixed(1)} dB)`;
            } else {
                text += ' · no echo';
            }
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
            startPinging(session, DEFAULT_CONFIG, (id) => {
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
