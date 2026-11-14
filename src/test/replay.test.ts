// The labelled recordings, replayed. Each starts cold: nothing is known
// about the phone's own response when the first ping comes in.
//
// The recordings were made hand-held in a room, so "nothing in front" still
// has the floor and the ceiling in range (the phone's speaker radiates in
// all directions), from about 1 m.
import { describe, expect, it } from 'vitest';
import { decodeFixture, type ReplayedPing, replay } from './fixtures';
import freespaceJson from './fixtures/freespace.json?raw';
import hand20Json from './fixtures/hand20cm.json?raw';
import handopenJson from './fixtures/handopen.json?raw';
import sweepJson from './fixtures/sweep.json?raw';
import wall20Json from './fixtures/wall20cm.json?raw';
import wall50Json from './fixtures/wall50cm.json?raw';

const run = (json: string) => replay(decodeFixture(json));

function estimates(pings: ReplayedPing[]): number[] {
    return pings.map((p) => p.estimate).filter((d): d is number => d !== null);
}

describe.each([
    ['free space', freespaceJson],
    ['hand-held, nothing in front', handopenJson],
])('%s', (_, json) => {
    const pings = run(json);

    it('hears every ping', () => {
        expect(pings.every((p) => p.valid)).toBe(true);
    });

    it("never reports the phone's own response as a nearby echo", () => {
        // This used to read 0.17 m.
        const found = estimates(pings);
        expect(found.length).toBeGreaterThan(pings.length / 2);
        expect(Math.min(...found)).toBeGreaterThan(0.9);
    });

    it('has at most a stray single ping below 0.9 m', () => {
        const near = pings.filter(
            (p) => p.distance !== null && p.distance < 0.9
        );
        expect(near.length).toBeLessThanOrEqual(1);
    });
});

describe('wall at 50 cm', () => {
    const pings = run(wall50Json);

    it('measures the wall from the second ping on', () => {
        expect(pings[0].estimate).toBeNull(); // one ping is not confirmed yet
        const found = pings.slice(1).map((p) => p.estimate);
        for (const d of found) {
            expect(d).toBeGreaterThan(0.47);
            expect(d).toBeLessThan(0.53);
        }
    });

    it('holds steady within a centimetre', () => {
        const found = estimates(pings);
        expect(Math.max(...found) - Math.min(...found)).toBeLessThan(0.01);
    });

    it('is fairly sure of having the right echo', () => {
        // The other echoes are weaker ones behind the wall.
        for (const p of pings.slice(1)) {
            expect(p.confidence).toBeGreaterThan(0.85);
            expect(p.peakError).toBeLessThan(0.06);
        }
    });
});

describe('wall at 20 cm', () => {
    const pings = run(wall20Json);

    it('drops the two pings during which the audio stream glitched', () => {
        expect(pings.filter((p) => !p.valid).length).toBeLessThanOrEqual(2);
    });

    // At 20 cm the echo merges with the tail of the phone's own response.
    // With the phone static from the first ping on, the two cannot be told
    // apart; the wall shows once the phone has moved a little (ping 4 here).
    it('does not invent a near echo while the wall cannot be told apart', () => {
        for (const p of pings.slice(0, 4)) {
            expect(p.distance).toBeGreaterThan(1);
        }
    });

    it('measures the wall once the phone has moved', () => {
        for (const p of pings.slice(6)) {
            expect(p.estimate).toBeGreaterThan(0.15);
            expect(p.estimate).toBeLessThan(0.22);
        }
    });
});

describe('hand held 20–30 cm in front, then taken away', () => {
    const pings = run(hand20Json);

    it('follows the hand', () => {
        for (const p of pings.slice(5, 22)) {
            expect(p.estimate).toBeGreaterThan(0.26);
            expect(p.estimate).toBeLessThan(0.34);
        }
    });

    it('is much less sure of the hand than of a wall', () => {
        // A weak echo close to the phone, with the floor clearer behind it.
        for (const p of pings.slice(5, 20)) {
            expect(p.confidence).toBeLessThan(0.7);
            expect(p.peakError).toBeGreaterThan(0.3);
        }
    });

    it('lets go of it within two pings', () => {
        // The hand is gone from ping 22 on.
        for (const p of pings.slice(24, 27)) {
            expect(p.estimate).toBeGreaterThan(1);
        }
    });
});

describe('moving towards a wall from 1.4 m', () => {
    const pings = run(sweepJson);
    /** The wall comes from 1.4 m to 0.3 m; after that it is too close. */
    const approach = pings.slice(1, 23);

    it('tracks the delay of the direct path as it drifts', () => {
        expect(pings.every((p) => p.valid)).toBe(true);
        const delays = pings.map((p) => p.delay);
        expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(100);
    });

    it('follows the wall all the way in', () => {
        const found = approach.map((p) => p.estimate as number);
        expect(found[0]).toBeGreaterThan(1.3);
        expect(found[found.length - 1]).toBeLessThan(0.35);
        // Moved by hand, about 5 cm per ping.
        for (let k = 1; k < found.length; k++) {
            expect(found[k]).toBeLessThan(found[k - 1]);
            expect(found[k]).toBeGreaterThan(found[k - 1] - 0.09);
        }
    });

    it('measures every single ping of the approach', () => {
        for (const p of approach) {
            expect(p.distance).not.toBeNull();
            expect(
                Math.abs((p.distance as number) - (p.estimate as number))
            ).toBeLessThan(0.04);
        }
    });
});
