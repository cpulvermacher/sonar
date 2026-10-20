// Message types shared between the main thread, the capture worklet and the DSP worker.

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
          /** A chirp has been scheduled to start playing at emitFrame. */
          type: 'ping';
          pingId: number;
          emitFrame: number;
      };

/** Worker -> main. */
export type FromWorker = {
    type: 'stats';
    framesReceived: number;
    /** RMS level of the most recent batch, in dBFS. */
    rmsDb: number;
};
