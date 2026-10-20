// Message types shared between the main thread, the capture worklet and the DSP worker.

import type { SonarConfig } from './config';

/** Worklet -> worker: a batch of consecutive mic samples. */
export interface CaptureBlock {
    /** AudioContext frame index of samples[0]. */
    startFrame: number;
    samples: Float32Array;
}

/** Main -> worker. */
export type ToWorker =
    | {
          type: 'init';
          port: MessagePort;
          sampleRate: number;
      }
    | {
          /** Pinging (re)starts with this config and emitted chirp. */
          type: 'start';
          config: SonarConfig;
          chirp: Float32Array;
      }
    | {
          /** A chirp has been scheduled to start playing at emitFrame. */
          type: 'ping';
          pingId: number;
          emitFrame: number;
      };

/** Worker -> main. */
export type FromWorker =
    | {
          type: 'stats';
          framesReceived: number;
          /** RMS level of the most recent batch, in dBFS. */
          rmsDb: number;
      }
    | {
          /** Analysis of one ping. Sample positions are relative to emitFrame. */
          type: 'echo';
          pingId: number;
          direct: number;
          directAmplitude: number;
          echo: number | null;
          echoAmplitude: number;
          noiseFloor: number;
          /** Max-pooled correlation envelope; envelope[i] covers samples from envStart + i·envStep. */
          envelope: Float32Array;
          envStart: number;
          envStep: number;
      };
