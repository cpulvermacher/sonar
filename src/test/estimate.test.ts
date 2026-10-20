import { describe, expect, it } from 'vitest';
import { DistanceEstimator, type EstimatorOptions } from '../estimate';

const options: EstimatorOptions = {
    window: 10,
    minSnrDb: 10,
    outlierSigmas: 3,
    minAccepted: 3,
    soundSpeedRelError: 0.0035,
};

const good = (distance: number) => ({ distance, sigma: 0.0005, snr: 1000 });

describe('DistanceEstimator', () => {
    it('needs a minimum number of accepted pings', () => {
        const est = new DistanceEstimator(options);
        est.push(good(1));
        est.push(good(1));
        expect(est.estimate()).toBeNull();
        est.push(good(1));
        expect(est.estimate()?.distance).toBe(1);
    });

    it('ignores pings without an echo or with low SNR', () => {
        const est = new DistanceEstimator(options);
        est.push(good(1));
        est.push(good(1.01));
        est.push({ distance: null, sigma: 1, snr: 0 });
        est.push({ distance: 3, sigma: 0.01, snr: 5 }); // 7 dB < 10 dB
        expect(est.estimate()).toBeNull();
        est.push(good(1.02));
        const e = est.estimate();
        expect(e?.distance).toBeCloseTo(1.01, 9);
        expect(e?.accepted).toBe(3);
        expect(e?.window).toBe(5);
    });

    it('rejects outliers', () => {
        const est = new DistanceEstimator(options);
        for (const d of [1.0, 1.001, 0.999, 1.0005, 0.9995, 2.5]) {
            est.push(good(d));
        }
        const e = est.estimate();
        expect(e?.accepted).toBe(5);
        expect(e?.distance).toBeCloseTo(1, 3);
    });

    it('only considers the most recent pings', () => {
        const est = new DistanceEstimator(options);
        for (let i = 0; i < 10; i++) {
            est.push(good(1));
        }
        for (let i = 0; i < 10; i++) {
            est.push(good(2));
        }
        expect(est.estimate()?.distance).toBe(2);
    });

    it('combines scatter, model and sound-speed errors', () => {
        const est = new DistanceEstimator(options);
        const ds = [0.99, 1.01, 0.995, 1.005, 1.0];
        for (const d of ds) {
            est.push(good(d));
        }
        const e = est.estimate();
        if (!e) {
            throw new Error('expected an estimate');
        }
        const std = Math.sqrt(
            ds.reduce((a, d) => a + (d - 1) ** 2, 0) / (ds.length - 1)
        );
        expect(e.sigmaStat).toBeCloseTo((1.2533 * std) / Math.sqrt(5), 9);
        expect(e.sigmaModel).toBeCloseTo(0.0005 / Math.sqrt(5), 9);
        expect(e.sigmaSound).toBeCloseTo(0.0035, 9);
        expect(e.sigma).toBeCloseTo(
            Math.hypot(e.sigmaStat, e.sigmaModel, e.sigmaSound),
            12
        );
    });
});
