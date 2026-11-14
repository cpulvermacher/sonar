import { describe, expect, it } from 'vitest';
import { type Motion, type MotionOptions, MotionTracker } from '../motion';

const options: MotionOptions = {
    gate: 20,
    window: 4,
    minMove: 8,
    hold: 6,
    maxGap: 2,
};

/** Feeds the candidate positions of consecutive pings; returns the last answer. */
function feed(tracker: MotionTracker, pings: number[][]): Motion[] {
    let out: Motion[] = [];
    for (const lags of pings) {
        out = tracker.update(lags);
    }
    return out;
}

/** n pings of an echo starting at `from` and moving by `step` per ping. */
const ramp = (from: number, step: number, n: number) =>
    Array.from({ length: n }, (_, k) => from + k * step);

describe('MotionTracker', () => {
    it('does not know about an echo until it has followed it for a while', () => {
        const tracker = new MotionTracker(options);
        expect(feed(tracker, [[100], [100], [100], [100]])).toEqual([
            'unknown',
        ]);
        expect(tracker.update([100])).toEqual(['still']);
    });

    it('tells the echo that moves from the one that stays', () => {
        const tracker = new MotionTracker(options);
        const pings = ramp(300, -3, 8).map((lag) => [100, lag]);
        expect(feed(tracker, pings)).toEqual(['still', 'moving']);
    });

    it('does not take jitter for movement', () => {
        const tracker = new MotionTracker(options);
        const pings = [100, 104, 99, 103, 98, 104, 100, 105, 99].map((l) => [
            l,
        ]);
        expect(feed(tracker, pings)).toEqual(['still']);
    });

    it('does not take a jump for movement', () => {
        // E.g. from one arrival in the echo's cluster to another.
        const tracker = new MotionTracker(options);
        const pings = [100, 100, 100, 112, 112, 112, 112, 112].map((l) => [l]);
        for (const lags of pings) {
            expect(tracker.update(lags)).not.toEqual(['moving']);
        }
    });

    it('follows an echo that moves further per ping than echoes are apart', () => {
        // Two echoes 10 lags apart, both moving by 12 per ping: the
        // nearest echo of the next ping is the other one.
        const tracker = new MotionTracker(options);
        const pings = ramp(400, -12, 8).map((lag) => [lag, lag + 10, 600]);
        expect(feed(tracker, pings)).toEqual(['moving', 'moving', 'still']);
    });

    it('keeps an echo as moving for a while after it has stopped', () => {
        const tracker = new MotionTracker(options);
        feed(
            tracker,
            ramp(300, -3, 8).map((lag) => [lag])
        );
        const after = Array.from({ length: 12 }, () => tracker.update([279]));
        expect(after[3]).toEqual(['moving']);
        expect(after[11]).toEqual(['still']);
    });

    it('forgets an echo that has been gone for too long', () => {
        const tracker = new MotionTracker(options);
        feed(
            tracker,
            ramp(300, -3, 8).map((lag) => [lag])
        );
        tracker.skip();
        tracker.skip();
        tracker.skip();
        expect(tracker.update([276])).toEqual(['unknown']);
    });
});
