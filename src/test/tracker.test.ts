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

describe('peak ambiguity', () => {
    const sure = { confidence: 1, nearer: 0, farther: 0, rival: null };
    const unsure = { confidence: 0.6, nearer: 0.02, farther: 0.3, rival: 1.2 };

    it('is that of the pings, averaged', () => {
        const tracker = make();
        tracker.push(0.5, sure);
        expect(tracker.push(0.5, sure)?.peak).toEqual(sure);
        const first = tracker.push(0.5, unsure)?.peak;
        expect(first?.farther).toBeGreaterThan(0);
        expect(first?.farther).toBeLessThan(0.1);
        expect(first?.rival).toBe(1.2);
        let last = first;
        for (let k = 0; k < 40; k++) {
            last = tracker.push(0.5, unsure)?.peak;
        }
        expect(last?.confidence).toBeCloseTo(0.6, 3);
        expect(last?.nearer).toBeCloseTo(0.02, 3);
        expect(last?.farther).toBeCloseTo(0.3, 3);
    });

    it('counts a ping that reports another distance as a wrong pick', () => {
        const tracker = make();
        feed(tracker, [0.5, 0.5]);
        // Each ping is sure of itself, but they do not agree.
        const peak = tracker.push(1.1, sure)?.peak;
        expect(peak?.confidence).toBeLessThan(0.9);
        expect(peak?.farther).toBeGreaterThan(0.05);
        expect(peak?.nearer).toBe(0);
        expect(peak?.rival).toBe(1.1);
        const back = tracker.push(0.2, sure)?.peak;
        expect(back?.nearer).toBeGreaterThan(0.03);
    });

    it('names the rival on the side of the larger error', () => {
        const tracker = make();
        feed(tracker, [1.27, 1.27]);
        // A stray ping far in front: most of the error is towards the phone.
        tracker.push(0.3, sure);
        // The next ping fits again and has a faint rival just behind it.
        const peak = tracker.push(1.27, {
            confidence: 0.99,
            nearer: 0,
            farther: 0.001,
            rival: 1.36,
        })?.peak;
        expect(peak?.nearer).toBeGreaterThan(peak?.farther as number);
        expect(peak?.rival).toBe(0.3);
    });

    it('starts afresh when the track jumps', () => {
        const tracker = make();
        feed(tracker, [0.5, 0.5]);
        tracker.push(1.1, sure);
        expect(tracker.push(1.1, sure)?.peak).toEqual(sure);
    });
});

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
