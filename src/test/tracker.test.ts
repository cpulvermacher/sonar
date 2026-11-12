import { describe, expect, it } from 'vitest';
import { DistanceTracker } from '../tracker';

const make = (interval = 0.05) =>
    new DistanceTracker({ interval, soundSpeedRelError: 0.01 });

/** Feeds the measurements and returns the estimate after the last one. */
function feed(tracker: DistanceTracker, values: (number | null)[]) {
    let estimate = tracker.estimate();
    for (const v of values) {
        estimate = tracker.push(v);
    }
    return estimate;
}

describe('DistanceTracker', () => {
    it('reports nothing until two pings agree', () => {
        const tracker = make();
        expect(tracker.push(1)).toBeNull();
        expect(tracker.push(1.02)?.distance).toBeCloseTo(1.01, 9);
    });

    it('does not start on two pings that disagree', () => {
        const tracker = make();
        expect(feed(tracker, [1, 1.6])).toBeNull();
        expect(feed(tracker, [1.61])?.distance).toBeCloseTo(1.605, 9);
    });

    it('smooths jitter', () => {
        const tracker = make();
        feed(tracker, [0.5, 0.5]);
        const out: number[] = [];
        for (let k = 0; k < 40; k++) {
            const jitter = k % 2 ? 0.003 : -0.003;
            out.push(tracker.push(0.5 + jitter)?.distance as number);
        }
        const settled = out.slice(10);
        const spread = Math.max(...settled) - Math.min(...settled);
        expect(spread).toBeLessThan(0.003); // half of what goes in
        expect(settled[0]).toBeCloseTo(0.5, 2);
    });

    it('follows movement with little lag', () => {
        const tracker = make();
        let d = 1.5;
        feed(tracker, [d, d]);
        // 1 m/s towards the wall: 5 cm per ping.
        for (let k = 0; k < 20; k++) {
            d -= 0.05;
            const estimate = tracker.push(d);
            expect(Math.abs((estimate?.distance as number) - d)).toBeLessThan(
                0.02
            );
        }
    });

    it('ignores a single outlier', () => {
        const tracker = make();
        feed(tracker, [0.5, 0.5, 0.5]);
        expect(tracker.push(1.7)?.distance).toBeCloseTo(0.5, 9);
        expect(tracker.push(0.5)?.distance).toBeCloseTo(0.5, 9);
        // Not remembered: a second, later one does not make it a jump.
        expect(tracker.push(1.7)?.distance).toBeCloseTo(0.5, 9);
    });

    it('jumps once a second ping confirms the new distance', () => {
        const tracker = make();
        feed(tracker, [0.5, 0.5, 0.5]);
        expect(feed(tracker, [1.7, 1.71])?.distance).toBeCloseTo(1.705, 9);
    });

    it('holds through a short gap, then drops the track', () => {
        const tracker = make(0.05); // holds for 0.3 s: 6 pings
        feed(tracker, [0.5, 0.5]);
        expect(feed(tracker, Array(6).fill(null))?.distance).toBeCloseTo(
            0.5,
            9
        );
        expect(tracker.push(null)).toBeNull();

        const slow = make(0.25); // at least two pings
        feed(slow, [0.5, 0.5]);
        expect(feed(slow, [null, null])).not.toBeNull();
        expect(slow.push(null)).toBeNull();
    });

    it('estimates the uncertainty from scatter and the speed of sound', () => {
        const tracker = make();
        const steady = feed(tracker, [2, 2, 2, 2]);
        expect(steady?.sigmaStat).toBe(0);
        expect(steady?.sigmaSound).toBeCloseTo(0.02, 9);
        expect(steady?.sigma).toBeCloseTo(0.02, 9);

        const noisy = feed(tracker, [2.03, 1.97, 2.03, 1.97, 2.03, 1.97]);
        expect(noisy?.sigmaStat).toBeGreaterThan(0.005);
        expect(noisy?.sigma).toBeGreaterThan(noisy?.sigmaSound as number);
    });

    it('starts over after a reset', () => {
        const tracker = make();
        feed(tracker, [0.5, 0.5]);
        tracker.reset();
        expect(tracker.estimate()).toBeNull();
        expect(tracker.push(0.5)).toBeNull();
    });
});
