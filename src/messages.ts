// Message types shared between the main thread, the capture worklet and the DSP worker.

import type { SonarConfig } from './config';
import type { PeakAmbiguity } from './ranging';

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

/** Analysis of one ping, see ranging.PingResult. */
export interface EchoMessage {
    type: 'echo';
    pingId: number;
    emitFrame: number;
    /** False if the direct path was not found; then only `raw` is meaningful. */
    valid: boolean;
    /** Delay from scheduling the chirp to hearing it, in frames, if known. */
    latency: number | null;
    /** Distance of the echo in m, if there is one. */
    distance: number | null;
    /** How uncertain it is that this is the right one of several echoes. */
    ambiguity: PeakAmbiguity | null;
    /** Power of the echo relative to the direct path. */
    level: number | null;
    /** Smoothed power relative to the direct path; power[l] is at lag l + lagOffset. */
    power: Float32Array;
    /** Power an echo needs at each lag. */
    threshold: Float32Array;
    lagOffset: number;
    /** The mic samples that were analysed, starting at context frame rawStart. */
    raw: Float32Array;
    rawStart: number;
    /** Position of the direct path in `raw`. */
    direct: number;
}

/** Worker -> main. */
export type FromWorker =
    | {
          type: 'stats';
          framesReceived: number;
          /** RMS level of the most recent batch, in dBFS. */
          rmsDb: number;
      }
    | EchoMessage;
