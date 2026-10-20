// AudioWorklet that forwards mic samples to the DSP worker in batches.
// Runs in the AudioWorkletGlobalScope, whose types are not part of the DOM lib.

import type { CaptureBlock } from './messages';

declare const currentFrame: number;
declare class AudioWorkletProcessor {
    readonly port: MessagePort;
}
declare function registerProcessor(
    name: string,
    ctor: new () => AudioWorkletProcessor
): void;

const BATCH_FRAMES = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
    private out: MessagePort | null = null;
    private batch = new Float32Array(BATCH_FRAMES);
    private fill = 0;
    private batchStart = 0;

    constructor() {
        super();
        this.port.onmessage = (e: MessageEvent<{ port: MessagePort }>) => {
            this.out = e.data.port;
        };
    }

    process(inputs: Float32Array[][]): boolean {
        const channel = inputs[0]?.[0];
        // Render quantum is 128 frames; a missing input is treated as silence
        // so that frame indices stay contiguous.
        const n = channel?.length ?? 128;
        if (this.fill === 0) {
            this.batchStart = currentFrame;
        }
        if (channel) {
            this.batch.set(channel, this.fill);
        } else {
            this.batch.fill(0, this.fill, this.fill + n);
        }
        this.fill += n;

        if (this.fill >= BATCH_FRAMES) {
            if (this.out) {
                const block: CaptureBlock = {
                    startFrame: this.batchStart,
                    samples: this.batch,
                };
                this.out.postMessage(block, [this.batch.buffer]);
            }
            this.batch = new Float32Array(BATCH_FRAMES);
            this.fill = 0;
        }
        return true;
    }
}

registerProcessor('capture', CaptureProcessor);
