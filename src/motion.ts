// Tells echoes whose distance changes from those that stay put. When the
// phone is moved towards a wall, or a hand moves in front of it, that echo
// moves along; the phone's own response does not, nor do (mostly) the floor
// and the ceiling. So of several echoes, one that moves is the better guess
// at what is being measured.

export interface MotionOptions {
    /** Echoes of consecutive pings at most this far apart (lags) are the same one. */
    gate: number;
    /** Movement is judged over this many pings. */
    window: number;
    /** An echo is moving if it has shifted by this much (lags) over the window. */
    minMove: number;
    /** An echo that has moved counts as moving for this many pings more. */
    hold: number;
    /** An echo not seen for more than this many pings is forgotten. */
    maxGap: number;
}

/**
 * 'unknown': not followed for long enough to tell, as with an echo that has
 * just appeared.
 */
export type Motion = 'moving' | 'still' | 'unknown';

interface Track {
    lag: number;
    /** Ping at which it was last seen. */
    seen: number;
    /** Its position at the pings of the window. */
    history: { ping: number; lag: number }[];
    /** Whether it had shifted over the window at the last ping. */
    shifted: boolean;
    /** Ping at which it was last found moving. */
    movedAt: number | null;
}

/**
 * A steady shift rather than a jump or jitter: no single step makes up most
 * of it, and little of the way was gone back and forth. (An echo is a
 * cluster of arrivals like the direct path, and the position found in it
 * can jump from one arrival to another.)
 */
const MAX_STEP_SHARE = 0.75;
const MAX_DETOUR = 1.3;

export class MotionTracker {
    private readonly options: MotionOptions;
    private tracks: Track[] = [];
    private ping = 0;

    constructor(options: MotionOptions) {
        this.options = options;
    }

    /** A ping without usable echoes has passed. */
    skip(): void {
        this.ping++;
    }

    /**
     * Takes the positions (lags) of the echo candidates of one ping, and
     * returns for each whether it is moving.
     */
    update(lags: number[]): Motion[] {
        const { gate, window, hold, maxGap } = this.options;
        const ping = this.ping++;
        this.tracks = this.tracks.filter((t) => ping - t.seen <= maxGap);

        // Closest pairs first.
        const pairs: { track: Track; index: number; distance: number }[] = [];
        for (const track of this.tracks) {
            // Where it should be now if it kept its speed. At a low ping
            // rate an echo moves further between pings than echoes are
            // apart, and the nearest one is not the same one.
            const h = track.history;
            const speed =
                h.length < 2
                    ? 0
                    : (h[h.length - 1].lag - h[h.length - 2].lag) /
                      (h[h.length - 1].ping - h[h.length - 2].ping);
            const expected = track.lag + speed * (ping - track.seen);
            for (let index = 0; index < lags.length; index++) {
                const distance = Math.abs(lags[index] - expected);
                if (distance <= gate * (ping - track.seen)) {
                    pairs.push({ track, index, distance });
                }
            }
        }
        pairs.sort((a, b) => a.distance - b.distance);
        const assigned = new Array<Track | undefined>(lags.length);
        const taken = new Set<Track>();
        for (const { track, index } of pairs) {
            if (!assigned[index] && !taken.has(track)) {
                assigned[index] = track;
                taken.add(track);
            }
        }

        return lags.map((lag, index) => {
            let track = assigned[index];
            if (!track) {
                track = {
                    lag,
                    seen: ping,
                    history: [],
                    shifted: false,
                    movedAt: null,
                };
                this.tracks.push(track);
            }
            track.lag = lag;
            track.seen = ping;
            track.history.push({ ping, lag });
            while (track.history[0].ping < ping - window) {
                track.history.shift();
            }
            // Twice in a row: once can be a mix-up of two echoes.
            const shifted = this.shifted(track);
            if (shifted && track.shifted) {
                track.movedAt = ping;
            }
            track.shifted = shifted;
            if (track.movedAt !== null && ping - track.movedAt <= hold) {
                return 'moving';
            }
            return this.known(track) ? 'still' : 'unknown';
        });
    }

    /** Whether the track's position is known over the whole window. */
    private known(track: Track): boolean {
        const h = track.history;
        return (
            h.length >= 4 &&
            h[0].ping <= h[h.length - 1].ping - this.options.window
        );
    }

    private shifted(track: Track): boolean {
        const h = track.history;
        if (!this.known(track)) {
            return false;
        }
        const net = Math.abs(h[h.length - 1].lag - h[0].lag);
        let path = 0;
        let maxStep = 0;
        for (let k = 1; k < h.length; k++) {
            const step = Math.abs(h[k].lag - h[k - 1].lag);
            path += step;
            maxStep = Math.max(maxStep, step);
        }
        return (
            net >= this.options.minMove &&
            maxStep <= MAX_STEP_SHARE * net &&
            path <= MAX_DETOUR * net
        );
    }
}
