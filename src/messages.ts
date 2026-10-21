// Message types shared between the main thread, the capture worklet and the DSP worker.

import type { SonarConfig } from './config';
import type { PeakCandidate } from './dsp';

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
          emitFrame: number;
          direct: number;
          /** Power SNR of the direct and echo peaks (echo: 0 if none). */
          directSnr: number;
          echo: number | null;
          echoSnr: number;
          /** Strongest local maxima in the echo search range, with their prominence. */
          candidates: PeakCandidate[];
          /** Model standard deviation of (echo − direct), in samples. */
          delaySigma: number;
          noiseFloor: number;
          /** Max-pooled correlation envelope; envelope[i] covers samples from envStart + i·envStep. */
          envelope: Float32Array;
          envStart: number;
          envStep: number;
          /** The raw mic samples that were analysed, starting at emitFrame. */
          raw: Float32Array;
      };
