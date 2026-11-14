import {
    type AudioSession,
    closeAudio,
    openAudio,
    startPinging,
} from './audio';
import {
    BANDS,
    type BandId,
    chirpBand,
    DEFAULT_CONFIG,
    ECHO_CHOICES,
    type EchoChoice,
    PING_RATES,
    type SonarConfig,
} from './config';
import { speedOfSound } from './dsp';
import type { FromWorker } from './messages';
import { watchHeading } from './orientation';
import { encodeRecording, Recorder } from './recording';
import { DistanceTracker } from './tracker';
import { SonarView, type ViewOptions } from './viz';
import './style.css';

/** Seconds of pings kept for "Save recording". */
const RECORDING_SECONDS = 10;

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) {
        throw new Error(`missing #${id}`);
    }
    return node as T;
}

const button = el<HTMLButtonElement>('toggle');
const saveButton = el<HTMLButtonElement>('save');
const bandSelect = el<HTMLSelectElement>('band');
const scaleInput = el<HTMLInputElement>('freq-scale');
const rateSelect = el<HTMLSelectElement>('rate');
const offsetInput = el<HTMLInputElement>('offset');
const preferSelect = el<HTMLSelectElement>('prefer');
const settingInputs = [
    bandSelect,
    scaleInput,
    rateSelect,
    offsetInput,
    preferSelect,
];
const chirpRange = el<HTMLElement>('chirp-range');
const status = el<HTMLElement>('status');
const errorBox = el<HTMLElement>('error');
const mapPanel = el<HTMLElement>('map-panel');
el('version').textContent =
    `Version ${import.meta.env.VITE_GIT_VERSION || 'dev'}`;

type Settings = Pick<
    SonarConfig,
    'band' | 'frequencyScale' | 'interval' | 'rangeOffset' | 'echoChoice'
>;

function viewOptions(config: SonarConfig, sampleRate: number): ViewOptions {
    return {
        metresPerSample: speedOfSound(config.temperature) / sampleRate / 2,
        rangeOffset: config.rangeOffset,
        minRange: config.blindRange + config.rangeOffset,
        maxRange: config.maxRange,
        interval: config.interval,
    };
}

function makeTracker(config: SonarConfig): DistanceTracker {
    return new DistanceTracker({
        interval: config.interval,
        // c = 331.3 + 0.606·T, so dc/dT = 0.606 m/s per °C.
        soundSpeedRelError:
            (0.606 * config.temperatureSigma) /
            speedOfSound(config.temperature),
    });
}

// The settings are applied on Start.
let config: SonarConfig = DEFAULT_CONFIG;
let tracker = makeTracker(config);
const view = new SonarView(viewOptions(config, 48000), {
    distance: el('distance'),
    sigma: el('sigma'),
    details: el('details'),
    ascan: el('ascan'),
    ascanTip: el('ascan-tip'),
    echogram: el('echogram'),
    echogramTip: el('echogram-tip'),
    map: el('map'),
});

let session: AudioSession | null = null;
let pingCount = 0;

// Kept after Stop, so a recording can still be saved.
const recorder = new Recorder(0);
let recordingInfo: { sampleRate: number; chirp: Float32Array } | null = null;

/** Latest direction of the phone, if it has an orientation sensor. */
let heading: number | null = null;
let stopHeading: (() => void) | null = null;

/** Remembered in this browser, as a convenience. */
const SETTINGS_KEY = 'sonar.settings.v2';

for (const [id, band] of Object.entries(BANDS)) {
    bandSelect.add(new Option(band.label, id));
}
for (const rate of PING_RATES) {
    rateSelect.add(new Option(String(rate), String(rate)));
}
rateSelect.value = String(Math.round(1 / DEFAULT_CONFIG.interval));
offsetInput.value = String(DEFAULT_CONFIG.rangeOffset * 100);
for (const [id, label] of Object.entries(ECHO_CHOICES)) {
    preferSelect.add(new Option(label, id));
}
preferSelect.value = DEFAULT_CONFIG.echoChoice;
try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (saved && saved.band in BANDS) {
        bandSelect.value = saved.band;
        scaleInput.value = String(saved.frequencyScale);
        rateSelect.value = String(Math.round(1 / saved.interval));
        offsetInput.value = String(saved.rangeOffset * 100);
        // Missing in settings saved before this choice existed.
        if (saved.echoChoice in ECHO_CHOICES) {
            preferSelect.value = saved.echoChoice;
        }
    }
} catch {
    // Defaults stay.
}

/** The settings from the controls, or null if one of them is invalid. */
function readSettings(): Settings | null {
    const frequencyScale = scaleInput.valueAsNumber;
    const rate = Number(rateSelect.value);
    const offset = offsetInput.valueAsNumber;
    if (!(frequencyScale > 0) || !(rate > 0) || !(offset >= 0)) {
        return null;
    }
    return {
        band: bandSelect.value as BandId,
        frequencyScale,
        interval: 1 / rate,
        rangeOffset: offset / 100,
        echoChoice: preferSelect.value as EchoChoice,
    };
}

function renderSettings() {
    const running = session !== null;
    for (const input of settingInputs) {
        input.disabled = running;
    }
    const settings = readSettings();
    if (!settings) {
        chirpRange.textContent =
            'Enter a multiplier above 0 and an offset of 0 or more.';
        return;
    }
    const band = chirpBand({ ...config, ...settings });
    const kHz = (f: number) => (f / 1000).toFixed(1);
    chirpRange.textContent = `Sweeps ${kHz(band.f0)}–${kHz(band.f1)} kHz${running ? '' : ', applied on Start'}.`;
}

for (const input of settingInputs) {
    input.addEventListener('input', () => {
        renderSettings();
        const settings = readSettings();
        if (!settings) {
            return;
        }
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {
            // Not remembered.
        }
    });
}
renderSettings();

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
            // A ping that was not heard counts as one without an echo.
            const estimate = tracker.push(
                msg.valid ? msg.distance : null,
                msg.ambiguity ?? undefined
            );
            recorder.push({
                pingId: msg.pingId,
                emitFrame: msg.emitFrame,
                startFrame: msg.rawStart,
                samples: msg.raw,
                distance: msg.distance,
            });
            saveButton.disabled = false;

            view.update({
                pingId: msg.pingId,
                valid: msg.valid,
                power: msg.power,
                threshold: msg.threshold,
                lagOffset: msg.lagOffset,
                distance: msg.distance,
                levelDb: msg.level === null ? null : 10 * Math.log10(msg.level),
                latencyMs:
                    msg.latency === null ? null : (msg.latency / fs) * 1000,
                estimate,
                heading,
            });
            break;
        }
    }
}

function setRunning(running: boolean) {
    button.textContent = running ? 'Stop' : 'Start';
    button.setAttribute('aria-pressed', String(running));
}

async function stop() {
    const s = session;
    session = null;
    stopHeading?.();
    stopHeading = null;
    heading = null;
    if (s) {
        await closeAudio(s);
    }
    status.textContent = '';
    setRunning(false);
    renderSettings();
}

async function start() {
    const settings = readSettings();
    if (!settings) {
        throw new Error(
            'Enter a frequency multiplier above 0 and an offset of 0 or more.'
        );
    }
    config = { ...DEFAULT_CONFIG, ...settings };
    // Asked for first: on iOS only right after the tap.
    stopHeading = await watchHeading((degrees) => {
        heading = degrees;
        mapPanel.hidden = false;
    });
    session = await openAudio(onWorkerMessage);
    renderSettings();
    pingCount = 0;
    tracker = makeTracker(config);
    view.reset(viewOptions(config, session.ctx.sampleRate));
    recorder.clear();
    recorder.capacity = Math.round(RECORDING_SECONDS / config.interval);
    saveButton.disabled = true;
    const chirp = startPinging(session, config, (id) => {
        pingCount = id + 1;
    });
    recordingInfo = { sampleRate: session.ctx.sampleRate, chirp };
    status.textContent = `${session.ctx.sampleRate} Hz`;
    setRunning(true);
}

button.addEventListener('click', async () => {
    button.disabled = true;
    errorBox.textContent = '';
    try {
        if (session) {
            await stop();
        } else {
            await start();
        }
    } catch (err) {
        // E.g. a chirp too high for the sample rate, after audio was opened.
        await stop().catch(() => {});
        errorBox.textContent = err instanceof Error ? err.message : String(err);
    } finally {
        button.disabled = false;
    }
});

el('clear-map').addEventListener('click', () => view.clearMap());

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
