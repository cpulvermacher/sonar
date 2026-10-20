// Audio graph setup (AudioContext, mic capture worklet, DSP worker) and
// chirp scheduling.

import workletUrl from './capture.worklet.ts?worker&url';
import { BANDS, type SonarConfig } from './config';
import { makeChirp } from './dsp';
import type { FromWorker, ToWorker } from './messages';

const PREFERRED_SAMPLE_RATE = 96000;

/** How often the scheduler wakes up, and how far ahead it schedules pings. */
const TIMER_MS = 25;
const LOOKAHEAD_S = 0.1;
/** Minimum lead time for start(), so a ping is never scheduled in the past. */
const MIN_LEAD_S = 0.02;

interface Pinger {
    timer: number;
    sources: Set<AudioBufferSourceNode>;
}

export interface AudioSession {
    ctx: AudioContext;
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    capture: AudioWorkletNode;
    worker: Worker;
    pinger: Pinger | null;
}

function getMic(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            // Echo cancellation would remove exactly the echo we want to measure.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
        },
    });
}

/**
 * Creates a context at the preferred sample rate and connects the mic to it.
 * Some browsers (Firefox) refuse to connect a mic stream to a context whose
 * rate differs from the device rate, so fall back to the default rate.
 */
async function createContext(
    stream: MediaStream
): Promise<{ ctx: AudioContext; source: MediaStreamAudioSourceNode }> {
    const attempts: AudioContextOptions[] = [
        { sampleRate: PREFERRED_SAMPLE_RATE, latencyHint: 'interactive' },
        { latencyHint: 'interactive' },
    ];
    let lastError: unknown;
    for (const options of attempts) {
        let ctx: AudioContext | undefined;
        try {
            ctx = new AudioContext(options);
            const source = ctx.createMediaStreamSource(stream);
            return { ctx, source };
        } catch (err) {
            lastError = err;
            await ctx?.close();
        }
    }
    throw lastError;
}

export async function openAudio(
    onMessage: (msg: FromWorker) => void
): Promise<AudioSession> {
    if (!window.isSecureContext) {
        throw new Error('Microphone access requires HTTPS or localhost.');
    }
    const stream = await getMic();
    let ctx: AudioContext | undefined;
    try {
        const created = await createContext(stream);
        ctx = created.ctx;
        await ctx.audioWorklet.addModule(workletUrl);
        const capture = new AudioWorkletNode(ctx, 'capture', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 1,
            channelCountMode: 'explicit',
        });
        created.source.connect(capture);

        const worker = new Worker(new URL('./dsp.worker.ts', import.meta.url), {
            type: 'module',
        });
        worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);

        // Mic samples go straight from the worklet to the worker.
        const channel = new MessageChannel();
        capture.port.postMessage({ port: channel.port1 }, [channel.port1]);
        const init: ToWorker = {
            type: 'init',
            port: channel.port2,
            sampleRate: ctx.sampleRate,
        };
        worker.postMessage(init, [channel.port2]);

        await ctx.resume();
        return {
            ctx,
            stream,
            source: created.source,
            capture,
            worker,
            pinger: null,
        };
    } catch (err) {
        for (const track of stream.getTracks()) {
            track.stop();
        }
        await ctx?.close();
        throw err;
    }
}

/**
 * Emits a chirp every config.interval seconds. Pings are scheduled on the
 * audio clock slightly ahead of time, so timing stays sample-exact even if
 * the main thread stalls. Each ping is announced to the worker with the
 * context frame at which it starts playing.
 */
export function startPinging(
    session: AudioSession,
    config: SonarConfig,
    onPing: (pingId: number) => void
): void {
    stopPinging(session);
    const { ctx, worker } = session;
    const band = BANDS[config.band];
    const samples = makeChirp(
        ctx.sampleRate,
        band.f0,
        band.f1,
        config.chirpDuration,
        config.amplitude
    );
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);

    const sources = new Set<AudioBufferSourceNode>();
    let nextTime = ctx.currentTime + MIN_LEAD_S;
    let pingId = 0;

    const schedule = () => {
        const now = ctx.currentTime;
        // If the timer was throttled (e.g. background tab), skip the missed
        // pings instead of firing them late.
        if (nextTime < now + MIN_LEAD_S) {
            const missed = Math.ceil(
                (now + MIN_LEAD_S - nextTime) / config.interval
            );
            nextTime += missed * config.interval;
        }
        while (nextTime < now + LOOKAHEAD_S) {
            const src = new AudioBufferSourceNode(ctx, { buffer });
            src.connect(ctx.destination);
            src.onended = () => {
                src.disconnect();
                sources.delete(src);
            };
            src.start(nextTime);
            sources.add(src);

            const msg: ToWorker = {
                type: 'ping',
                pingId,
                emitFrame: Math.round(nextTime * ctx.sampleRate),
            };
            worker.postMessage(msg);
            onPing(pingId);

            pingId++;
            nextTime += config.interval;
        }
    };

    schedule();
    session.pinger = { timer: window.setInterval(schedule, TIMER_MS), sources };
}

export function stopPinging(session: AudioSession): void {
    const pinger = session.pinger;
    if (!pinger) {
        return;
    }
    window.clearInterval(pinger.timer);
    for (const src of pinger.sources) {
        src.stop();
        src.disconnect();
    }
    pinger.sources.clear();
    session.pinger = null;
}

export async function closeAudio(session: AudioSession): Promise<void> {
    stopPinging(session);
    session.source.disconnect();
    session.capture.disconnect();
    for (const track of session.stream.getTracks()) {
        track.stop();
    }
    session.worker.terminate();
    await session.ctx.close();
}
