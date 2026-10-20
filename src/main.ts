import { type AudioSession, closeAudio, openAudio } from './audio';
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

let session: AudioSession | null = null;

function onWorkerMessage(msg: FromWorker) {
    if (!session) {
        return;
    }
    switch (msg.type) {
        case 'stats': {
            const secs = msg.framesReceived / session.ctx.sampleRate;
            status.textContent =
                `${session.ctx.sampleRate} Hz · mic ${msg.rmsDb.toFixed(1)} dBFS` +
                ` · ${secs.toFixed(1)} s captured`;
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
