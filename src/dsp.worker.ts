// DSP worker. For now it only receives mic batches and reports basic stats.

import type { CaptureBlock, FromWorker, ToWorker } from './messages';

const STATS_INTERVAL_MS = 250;

let framesReceived = 0;
let lastStats = 0;

function post(msg: FromWorker) {
    self.postMessage(msg);
}

function onBlock(block: CaptureBlock) {
    framesReceived += block.samples.length;

    const now = performance.now();
    if (now - lastStats < STATS_INTERVAL_MS) {
        return;
    }
    lastStats = now;

    let sum = 0;
    for (const s of block.samples) {
        sum += s * s;
    }
    const rms = Math.sqrt(sum / block.samples.length);
    post({
        type: 'stats',
        framesReceived,
        rmsDb: 20 * Math.log10(rms + 1e-12),
    });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
    const msg = e.data;
    switch (msg.type) {
        case 'init':
            framesReceived = 0;
            msg.port.onmessage = (ev: MessageEvent<CaptureBlock>) =>
                onBlock(ev.data);
            break;
    }
};
