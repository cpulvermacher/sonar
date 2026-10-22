// Rendering: distance readout, A-scan of the latest ping, echogram history
// and a table of recent pings. Plain Canvas 2D, colours from CSS tokens.

import { median, type PeakCandidate } from './dsp';
import type { Estimate } from './estimate';

export interface PingView {
    pingId: number;
    /** Max-pooled correlation envelope; envelope[i] covers samples from envStart + i·envStep. */
    envelope: Float32Array;
    envStart: number;
    envStep: number;
    /** Median of the full (unpooled) envelope, the SNR reference. */
    noiseFloor: number;
    /** Peak positions in samples, on the same axis as envStart. */
    direct: number;
    echo: number | null;
    /** Strongest local maxima considered for the echo. */
    candidates: PeakCandidate[];
    /** Converts a round-trip delay in samples to one-way distance in m. */
    metresPerSample: number;
    /** This ping's distance (m) and its model σ, if an echo was found. */
    distance: number | null;
    sigma: number;
    echoSnrDb: number | null;
    latencyMs: number;
    estimate: Estimate | null;
}

export interface ViewOptions {
    minRange: number;
    maxRange: number;
    interval: number;
    minEchoSnrDb: number;
    minEchoProminenceDb: number;
    backgroundMarginDb: number;
}

/** Lowest level shown, in dB relative to the direct path. */
const DB_FLOOR = -50;
/** Pings kept in the echogram, and distance rows per ping. */
const HISTORY = 240;
const ROWS = 200;
const TABLE_ROWS = 10;
const MARGIN = { left: 48, right: 12, top: 20, bottom: 28 };
const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';

interface Theme {
    surface: string;
    textSecondary: string;
    textMuted: string;
    grid: string;
    axis: string;
    series1: string;
    series2: string;
    /** 256 RGB entries of the sequential ramp. */
    lut: Uint8ClampedArray;
}

interface Column {
    pingId: number;
    /** dB per distance row (row 0 = nearest), NaN where there is no data. */
    rows: Float32Array;
    estimate: number | null;
}

interface Hover {
    x: number;
    y: number;
}

function hexToRgb(hex: string): [number, number, number] {
    const n = Number.parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeLut(stops: string[]): Uint8ClampedArray {
    const rgb = stops.map(hexToRgb);
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
        const t = (i / 255) * (rgb.length - 1);
        const k = Math.min(rgb.length - 2, Math.floor(t));
        const f = t - k;
        for (let c = 0; c < 3; c++) {
            lut[i * 3 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * f;
        }
    }
    return lut;
}

function readTheme(): Theme {
    const style = getComputedStyle(document.documentElement);
    const v = (name: string) => style.getPropertyValue(name).trim();
    return {
        surface: v('--surface'),
        textSecondary: v('--text-secondary'),
        textMuted: v('--text-muted'),
        grid: v('--grid'),
        axis: v('--axis'),
        series1: v('--series-1'),
        series2: v('--series-2'),
        lut: makeLut(
            v('--ramp')
                .split(',')
                .map((s) => s.trim())
        ),
    };
}

/** Round tick values covering [min, max], about `target` of them. */
export function niceTicks(min: number, max: number, target = 5): number[] {
    const raw = (max - min) / target;
    if (!(raw > 0)) {
        return [];
    }
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks: number[] = [];
    for (
        let t = Math.ceil(min / step) * step;
        t <= max + step * 1e-9;
        t += step
    ) {
        ticks.push(Number(t.toFixed(10)));
    }
    return ticks;
}

function toDb(value: number, reference: number): number {
    return 20 * Math.log10(Math.max(value, 1e-12) / reference);
}

/** A canvas sized to its CSS box at device pixel ratio, drawn in CSS px. */
class Surface {
    readonly ctx: CanvasRenderingContext2D;
    width = 0;
    height = 0;

    constructor(readonly canvas: HTMLCanvasElement) {
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas 2D not supported');
        }
        this.ctx = ctx;
    }

    /** Matches the backing store to the element size and clears it. */
    begin(theme: Theme): void {
        const dpr = window.devicePixelRatio || 1;
        this.width = this.canvas.clientWidth;
        this.height = this.canvas.clientHeight;
        const w = Math.round(this.width * dpr);
        const h = Math.round(this.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.fillStyle = theme.surface;
        this.ctx.fillRect(0, 0, this.width, this.height);
        this.ctx.font = FONT;
    }

    get plot() {
        return {
            x: MARGIN.left,
            y: MARGIN.top,
            w: Math.max(1, this.width - MARGIN.left - MARGIN.right),
            h: Math.max(1, this.height - MARGIN.top - MARGIN.bottom),
        };
    }
}

export class SonarView {
    private theme = readTheme();
    private latest: PingView | null = null;
    /** Background power relative to the direct path, per sample of lag. */
    private background: Float32Array | null = null;
    private columns: Column[] = [];
    private recent: PingView[] = [];
    private ascan: Surface;
    private echogram: Surface;
    private image = document.createElement('canvas');
    private ascanHover: Hover | null = null;
    private echogramHover: Hover | null = null;
    private dirty = true;

    constructor(
        private readonly options: ViewOptions,
        private readonly el: {
            distance: HTMLElement;
            sigma: HTMLElement;
            details: HTMLElement;
            ascan: HTMLCanvasElement;
            ascanTip: HTMLElement;
            echogram: HTMLCanvasElement;
            echogramTip: HTMLElement;
            table: HTMLTableSectionElement;
        }
    ) {
        this.ascan = new Surface(el.ascan);
        this.echogram = new Surface(el.echogram);
        this.image.width = HISTORY;
        this.image.height = ROWS;

        const observer = new ResizeObserver(() => this.invalidate());
        observer.observe(el.ascan);
        observer.observe(el.echogram);
        window
            .matchMedia('(prefers-color-scheme: dark)')
            .addEventListener('change', () => {
                this.theme = readTheme();
                this.invalidate();
            });

        this.trackHover(el.ascan, (h) => {
            this.ascanHover = h;
        });
        this.trackHover(el.echogram, (h) => {
            this.echogramHover = h;
        });

        const frame = () => {
            if (this.dirty) {
                this.dirty = false;
                this.draw();
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    reset(): void {
        this.latest = null;
        this.columns = [];
        this.recent = [];
        this.renderReadout();
        this.renderTable();
        this.invalidate();
    }

    update(ping: PingView): void {
        this.latest = ping;
        this.columns.push(this.makeColumn(ping));
        if (this.columns.length > HISTORY) {
            this.columns.shift();
        }
        this.recent.unshift(ping);
        this.recent.length = Math.min(this.recent.length, TABLE_ROWS);
        this.renderReadout();
        this.renderTable();
        this.invalidate();
    }

    setBackground(power: Float32Array | null): void {
        this.background = power;
        this.invalidate();
    }

    private invalidate(): void {
        this.dirty = true;
    }

    private newestPingId(): number | undefined {
        return this.columns[this.columns.length - 1]?.pingId;
    }

    private trackHover(
        canvas: HTMLCanvasElement,
        set: (h: Hover | null) => void
    ) {
        canvas.addEventListener('pointermove', (e) => {
            set({ x: e.offsetX, y: e.offsetY });
            this.invalidate();
        });
        canvas.addEventListener('pointerleave', () => {
            set(null);
            this.invalidate();
        });
    }

    /** Envelope sample index (into ping.envelope) for a distance in m. */
    private envIndex(ping: PingView, distance: number): number {
        const sample = ping.direct + distance / ping.metresPerSample;
        return (sample - ping.envStart) / ping.envStep;
    }

    /** Distance in m of a peak at sample position `index`. */
    private peakDistance(ping: PingView, index: number): number {
        return (index - ping.direct) * ping.metresPerSample;
    }

    private envDistance(ping: PingView, i: number): number {
        const sample = ping.envStart + (i + 0.5) * ping.envStep;
        return (sample - ping.direct) * ping.metresPerSample;
    }

    private reference(ping: PingView): number {
        return ping.envelope.reduce((m, v) => Math.max(m, v), 1e-12);
    }

    /** Envelope amplitude at which an echo reaches the SNR threshold (inverse of peakSnr). */
    private snrThreshold(ping: PingView): number {
        const snr = 10 ** (this.options.minEchoSnrDb / 10);
        return ping.noiseFloor * Math.sqrt(snr / Math.LN2);
    }

    /**
     * How far each recent ping's direct path lies from their median, in m of
     * distance; a shifted reference shifts the measured distance by as much.
     */
    private directShifts(): number[] {
        const directs = this.recent.map((p) => p.direct);
        const mid = median(directs);
        return this.recent.map((p) => (p.direct - mid) * p.metresPerSample);
    }

    private makeColumn(ping: PingView): Column {
        const rows = new Float32Array(ROWS).fill(Number.NaN);
        const ref = this.reference(ping);
        const rowSize = this.options.maxRange / ROWS;
        for (let r = 0; r < ROWS; r++) {
            const from = Math.max(
                0,
                Math.floor(this.envIndex(ping, r * rowSize))
            );
            const to = Math.min(
                ping.envelope.length,
                Math.ceil(this.envIndex(ping, (r + 1) * rowSize))
            );
            let max = 0;
            for (
                let i = from;
                i < Math.max(to, from + 1) && i < ping.envelope.length;
                i++
            ) {
                max = Math.max(max, ping.envelope[i]);
            }
            if (from < ping.envelope.length) {
                rows[r] = toDb(max, ref);
            }
        }
        return {
            pingId: ping.pingId,
            rows,
            estimate: ping.estimate?.distance ?? null,
        };
    }

    // --- Text ---------------------------------------------------------------

    private renderReadout(): void {
        const { el } = this;
        const ping = this.latest;
        const est = ping?.estimate ?? null;
        if (!ping) {
            el.distance.textContent = '—';
            el.sigma.textContent = '';
            el.details.textContent = '';
            return;
        }
        if (!est) {
            el.distance.textContent = 'No echo';
            el.sigma.textContent = '';
        } else {
            el.distance.textContent = `${est.distance.toFixed(3)} m`;
            el.sigma.textContent = `± ${mm(est.sigma)}`;
        }
        const parts: string[] = [];
        if (est) {
            parts.push(
                `scatter ${mm(est.sigmaStat)}`,
                `SNR model ${mm(est.sigmaModel)}`,
                `sound speed ${mm(est.sigmaSound)}`,
                `${est.accepted} of ${est.window} pings`
            );
        }
        parts.push(
            ping.echoSnrDb === null
                ? 'no echo this ping'
                : `echo SNR ${ping.echoSnrDb.toFixed(1)} dB`,
            `latency ${ping.latencyMs.toFixed(1)} ms`
        );
        if (this.recent.length >= 2) {
            parts.push(`direct path jitter ${mm(rms(this.directShifts()))}`);
        }
        el.details.textContent = parts.join(' · ');
    }

    private renderTable(): void {
        const shifts = this.directShifts();
        const rows = this.recent.map((p, k) => {
            const tr = document.createElement('tr');
            const cells = [
                String(p.pingId),
                p.distance === null ? '—' : p.distance.toFixed(3),
                p.distance === null ? '—' : (p.sigma * 1000).toFixed(2),
                p.echoSnrDb === null ? '—' : p.echoSnrDb.toFixed(1),
                (shifts[k] * 1000).toFixed(1),
            ];
            for (const text of cells) {
                const td = document.createElement('td');
                td.textContent = text;
                tr.append(td);
            }
            return tr;
        });
        this.el.table.replaceChildren(...rows);
    }

    // --- Canvas -------------------------------------------------------------

    private draw(): void {
        this.drawAscan();
        this.drawEchogram();
    }

    private drawAxes(
        s: Surface,
        xTicks: number[],
        xPos: (v: number) => number,
        xLabel: (v: number) => string,
        yTicks: number[],
        yPos: (v: number) => number,
        yLabel: (v: number) => string,
        gridOnTop = false
    ): void {
        const { ctx } = s;
        const p = s.plot;
        const t = this.theme;
        ctx.lineWidth = 1;
        if (!gridOnTop) {
            ctx.strokeStyle = t.grid;
            ctx.beginPath();
            for (const v of yTicks) {
                const y = Math.round(yPos(v)) + 0.5;
                ctx.moveTo(p.x, y);
                ctx.lineTo(p.x + p.w, y);
            }
            for (const v of xTicks) {
                const x = Math.round(xPos(v)) + 0.5;
                ctx.moveTo(x, p.y);
                ctx.lineTo(x, p.y + p.h);
            }
            ctx.stroke();
        }
        ctx.strokeStyle = t.axis;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y + p.h + 0.5);
        ctx.lineTo(p.x + p.w, p.y + p.h + 0.5);
        ctx.stroke();

        ctx.fillStyle = t.textMuted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const v of xTicks) {
            ctx.fillText(xLabel(v), xPos(v), p.y + p.h + 6);
        }
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const v of yTicks) {
            ctx.fillText(yLabel(v), p.x - 6, yPos(v));
        }
    }

    private drawAscan(): void {
        const s = this.ascan;
        const t = this.theme;
        s.begin(t);
        const { ctx } = s;
        const p = s.plot;
        const ping = this.latest;
        const { minRange, maxRange } = this.options;

        const xMin = ping
            ? Math.min(0, this.envDistance(ping, 0))
            : -maxRange / 16;
        const xScale = (d: number) =>
            p.x + ((d - xMin) / (maxRange - xMin)) * p.w;
        const yScale = (db: number) => p.y + (-db / -DB_FLOOR) * p.h;
        const xTicks = niceTicks(
            0,
            maxRange,
            Math.max(2, Math.floor(p.w / 90))
        );
        const yTicks = niceTicks(DB_FLOOR, 0, 5);
        this.drawAxes(
            s,
            xTicks,
            xScale,
            (v) => `${v} m`,
            yTicks,
            yScale,
            (v) => `${v}`
        );

        ctx.save();
        ctx.beginPath();
        ctx.rect(p.x, p.y, p.w, p.h);
        ctx.clip();

        // Blanked region next to the direct path.
        ctx.fillStyle = t.textMuted;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(xScale(0), p.y, xScale(minRange) - xScale(0), p.h);
        ctx.globalAlpha = 1;

        if (ping && this.background) {
            // What is removed: the background plus its margin.
            const bg = this.background;
            const start = Math.ceil(minRange / ping.metresPerSample);
            ctx.fillStyle = t.textMuted;
            ctx.globalAlpha = 0.25;
            ctx.beginPath();
            ctx.moveTo(xScale(start * ping.metresPerSample), p.y + p.h);
            for (let j = start; j < bg.length; j++) {
                const db =
                    10 * Math.log10(Math.max(bg[j], 1e-12)) +
                    this.options.backgroundMarginDb;
                ctx.lineTo(
                    xScale(j * ping.metresPerSample),
                    yScale(Math.max(DB_FLOOR, Math.min(0, db)))
                );
            }
            ctx.lineTo(xScale(bg.length * ping.metresPerSample), p.y + p.h);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        if (ping) {
            const ref = this.reference(ping);
            const est = ping.estimate;
            if (est) {
                const x0 = xScale(est.distance - est.sigma);
                const x1 = xScale(est.distance + est.sigma);
                ctx.fillStyle = t.series2;
                ctx.globalAlpha = 0.15;
                ctx.fillRect(x0, p.y, Math.max(x1 - x0, 6), p.h);
                ctx.globalAlpha = 1;
                ctx.fillRect(xScale(est.distance) - 1, p.y, 2, p.h);
            }

            // Echoes below this line are too weak to count for the estimate.
            const yMin = Math.round(yScale(toDb(this.snrThreshold(ping), ref)));
            ctx.strokeStyle = t.textMuted;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(p.x, yMin + 0.5);
            ctx.lineTo(p.x + p.w, yMin + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = t.textMuted;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText('min SNR', p.x + p.w - 4, yMin - 2);

            ctx.strokeStyle = t.series1;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.beginPath();
            for (let i = 0; i < ping.envelope.length; i++) {
                const x = xScale(this.envDistance(ping, i));
                const y = yScale(
                    Math.max(DB_FLOOR - 1, toDb(ping.envelope[i], ref))
                );
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();

            // Echo candidates: a stem from each peak down to the trough its
            // prominence is measured against. Prominent enough = darker, thicker.
            for (const c of ping.candidates) {
                const x =
                    Math.round(xScale(this.peakDistance(ping, c.index))) + 0.5;
                const top = yScale(toDb(c.amplitude, ref));
                const base = yScale(
                    Math.max(DB_FLOOR, toDb(c.amplitude / c.prominence, ref))
                );
                const passes =
                    toDb(c.prominence, 1) >= this.options.minEchoProminenceDb;
                ctx.strokeStyle = passes ? t.textSecondary : t.textMuted;
                ctx.lineWidth = passes ? 2 : 1;
                ctx.beginPath();
                ctx.moveTo(x, top);
                ctx.lineTo(x, base);
                ctx.moveTo(x - 4, base);
                ctx.lineTo(x + 4, base);
                ctx.stroke();
            }

            if (ping.echo !== null) {
                const d = this.peakDistance(ping, ping.echo);
                const i = Math.round(this.envIndex(ping, d) - 0.5);
                const db = toDb(
                    ping.envelope[
                        Math.max(0, Math.min(i, ping.envelope.length - 1))
                    ],
                    ref
                );
                this.dot(ctx, xScale(d), yScale(db), t.series1);
            }
        }
        ctx.restore();

        ctx.fillStyle = t.textMuted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText('direct', xScale(0) + 2, p.y - 4);

        this.ascanTooltip(p, xScale, yScale, xMin);
    }

    private ascanTooltip(
        p: { x: number; y: number; w: number; h: number },
        xScale: (d: number) => number,
        yScale: (db: number) => number,
        xMin: number
    ): void {
        const tip = this.el.ascanTip;
        const ping = this.latest;
        const hover = this.ascanHover;
        if (!ping || !hover || hover.x < p.x || hover.x > p.x + p.w) {
            tip.hidden = true;
            return;
        }
        const { ctx } = this.ascan;
        const d =
            xMin + ((hover.x - p.x) / p.w) * (this.options.maxRange - xMin);
        const i = Math.round(this.envIndex(ping, d) - 0.5);
        if (i < 0 || i >= ping.envelope.length) {
            tip.hidden = true;
            return;
        }
        const db = toDb(ping.envelope[i], this.reference(ping));
        const x = xScale(this.envDistance(ping, i));
        ctx.strokeStyle = this.theme.axis;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, p.y);
        ctx.lineTo(Math.round(x) + 0.5, p.y + p.h);
        ctx.stroke();
        this.dot(ctx, x, yScale(Math.max(DB_FLOOR, db)), this.theme.series1);
        const parts = [`${d.toFixed(3)} m`, `${db.toFixed(1)} dB`];
        const near = ping.candidates.find(
            (c) =>
                Math.abs(xScale(this.peakDistance(ping, c.index)) - hover.x) <=
                6
        );
        if (near) {
            parts.push(
                `peak prominence ${toDb(near.prominence, 1).toFixed(1)} dB`
            );
        }
        this.showTip(
            tip,
            this.ascan,
            x,
            yScale(Math.max(DB_FLOOR, db)),
            parts.join(' · ')
        );
    }

    private drawEchogram(): void {
        const s = this.echogram;
        const t = this.theme;
        s.begin(t);
        const { ctx } = s;
        const p = s.plot;
        const { maxRange, interval } = this.options;
        const newest = this.newestPingId() ?? 0;
        const colWidth = p.w / HISTORY;
        const colX = (pingId: number) =>
            p.x + p.w - (newest - pingId + 1) * colWidth;
        const yScale = (d: number) => p.y + p.h - (d / maxRange) * p.h;

        // Intensity image: one pixel per (ping, distance row).
        const img = new ImageData(HISTORY, ROWS);
        for (const col of this.columns) {
            const x = HISTORY - 1 - (newest - col.pingId);
            if (x < 0) {
                continue;
            }
            for (let r = 0; r < ROWS; r++) {
                const db = col.rows[r];
                if (Number.isNaN(db)) {
                    continue;
                }
                const level = Math.round(
                    Math.max(0, Math.min(1, 1 - db / DB_FLOOR)) * 255
                );
                const o = ((ROWS - 1 - r) * HISTORY + x) * 4;
                img.data[o] = t.lut[level * 3];
                img.data[o + 1] = t.lut[level * 3 + 1];
                img.data[o + 2] = t.lut[level * 3 + 2];
                img.data[o + 3] = 255;
            }
        }
        const imgCtx = this.image.getContext('2d');
        imgCtx?.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.image, p.x, p.y, p.w, p.h);

        const span = HISTORY * interval;
        this.drawAxes(
            s,
            niceTicks(0, span, Math.max(2, Math.floor(p.w / 90))),
            (secs) => p.x + p.w - (secs / span) * p.w,
            (secs) => (secs === 0 ? 'now' : `−${secs} s`),
            niceTicks(0, maxRange, 4),
            yScale,
            (v) => `${v} m`,
            true
        );

        // Estimate trace, with a surface-coloured halo so it reads over the image.
        ctx.save();
        ctx.beginPath();
        ctx.rect(p.x, p.y, p.w, p.h);
        ctx.clip();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const [color, width] of [
            [t.surface, 4],
            [t.series2, 2],
        ] as const) {
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.beginPath();
            let drawing = false;
            for (const col of this.columns) {
                if (col.estimate === null) {
                    drawing = false;
                    continue;
                }
                const x = colX(col.pingId) + colWidth / 2;
                const y = yScale(col.estimate);
                if (drawing) {
                    ctx.lineTo(x, y);
                } else {
                    ctx.moveTo(x, y);
                    drawing = true;
                }
            }
            ctx.stroke();
        }
        ctx.restore();

        this.echogramTooltip(p, colX, colWidth);
    }

    private echogramTooltip(
        p: { x: number; y: number; w: number; h: number },
        colX: (pingId: number) => number,
        colWidth: number
    ): void {
        const tip = this.el.echogramTip;
        const hover = this.echogramHover;
        const newest = this.newestPingId();
        if (
            newest === undefined ||
            !hover ||
            hover.x < p.x ||
            hover.x > p.x + p.w ||
            hover.y < p.y ||
            hover.y > p.y + p.h
        ) {
            tip.hidden = true;
            return;
        }
        const pingId = newest - Math.floor((p.x + p.w - hover.x) / colWidth);
        const col = this.columns.find((c) => c.pingId === pingId);
        if (!col) {
            tip.hidden = true;
            return;
        }
        const d = ((p.y + p.h - hover.y) / p.h) * this.options.maxRange;
        const r = Math.min(
            ROWS - 1,
            Math.floor((d / this.options.maxRange) * ROWS)
        );
        const db = col.rows[r];
        const { ctx } = this.echogram;
        ctx.strokeStyle = this.theme.textSecondary;
        ctx.lineWidth = 1;
        ctx.strokeRect(
            Math.round(colX(pingId)) + 0.5,
            p.y + 0.5,
            Math.max(1, Math.round(colWidth)),
            p.h - 1
        );
        const parts = [`ping ${pingId}`, `${d.toFixed(2)} m`];
        if (!Number.isNaN(db)) {
            parts.push(`${db.toFixed(1)} dB`);
        }
        if (col.estimate !== null) {
            parts.push(`estimate ${col.estimate.toFixed(3)} m`);
        }
        this.showTip(tip, this.echogram, hover.x, hover.y, parts.join(' · '));
    }

    /** A ≥8px marker with a 2px surface ring. */
    private dot(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        color: string
    ) {
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = this.theme.surface;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
    }

    private showTip(
        tip: HTMLElement,
        s: Surface,
        x: number,
        y: number,
        text: string
    ) {
        tip.textContent = text;
        tip.hidden = false;
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const left = x + 12 + w > s.width ? x - 12 - w : x + 12;
        const top = Math.max(0, Math.min(s.height - h, y - h - 8));
        tip.style.left = `${Math.max(0, left)}px`;
        tip.style.top = `${top}px`;
    }
}

function rms(values: number[]): number {
    return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

function mm(metres: number): string {
    const v = metres * 1000;
    return `${v < 1 ? v.toFixed(2) : v.toFixed(1)} mm`;
}
