// Audio graph setup: AudioContext, mic capture worklet and DSP worker.

import workletUrl from './capture.worklet.ts?worker&url';
import type { FromWorker, ToWorker } from './messages';

const PREFERRED_SAMPLE_RATE = 96000;

export interface AudioSession {
    ctx: AudioContext;
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    capture: AudioWorkletNode;
    worker: Worker;
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
        return { ctx, stream, source: created.source, capture, worker };
    } catch (err) {
        for (const track of stream.getTracks()) {
            track.stop();
        }
        await ctx?.close();
        throw err;
    }
}

export async function closeAudio(session: AudioSession): Promise<void> {
    session.source.disconnect();
    session.capture.disconnect();
    for (const track of session.stream.getTracks()) {
        track.stop();
    }
    session.worker.terminate();
    await session.ctx.close();
}
