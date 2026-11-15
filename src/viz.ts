// Rendering: distance readout, A-scan of the latest ping and echogram
// history. Plain Canvas 2D, colours from CSS tokens.

import type { Estimate } from './tracker';

export interface PingView {
    pingId: number;
    /** False if the ping could not be analysed (no direct path found). */
    valid: boolean;
    /** Smoothed power relative to the direct path; power[l] is at lag l + lagOffset. */
    power: Float32Array;
    /** Power an echo needs at each lag (empty if not valid). */
    threshold: Float32Array;
    lagOffset: number;
    /** This ping's distance (m) and echo level (dB re direct), if an echo was found. */
    distance: number | null;
    levelDb: number | null;
    latencyMs: number | null;
    estimate: Estimate | null;
}

export interface ViewOptions {
    /** Converts a round-trip delay in samples to one-way distance in m. */
    metresPerSample: number;
    /** Distance (m) at lag 0, see SonarConfig.rangeOffset. */
    rangeOffset: number;
    /** No echoes are searched for below this distance (m). */
    minRange: number;
    maxRange: number;
    /** Time between pings in s. */
    interval: number;
}

/** Lowest level shown, in dB relative to the direct path. */
const DB_FLOOR = -60;
/** Pings kept in the echogram, and distance rows per ping. */
const HISTORY = 240;
const ROWS = 200;
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

/** Power ratio to dB. */
function toDb(power: number): number {
    return 10 * Math.log10(Math.max(power, 1e-12));
}

/** A canvas sized to its CSS box at device pixel ratio, drawn in CSS px. */
class Surface {
    readonly ctx: CanvasRenderingContext2D;
    readonly canvas: HTMLCanvasElement;
    width = 0;
    height = 0;

    constructor(canvas: HTMLCanvasElement) {
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas 2D not supported');
        }
        this.canvas = canvas;
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

export interface ViewElements {
    distance: HTMLElement;
    sigma: HTMLElement;
    details: HTMLElement;
    pingStats: HTMLElement;
    ascan: HTMLCanvasElement;
    ascanTip: HTMLElement;
    echogram: HTMLCanvasElement;
    echogramTip: HTMLElement;
}

export class SonarView {
    private theme = readTheme();
    private options: ViewOptions;
    private readonly el: ViewElements;
    private latest: PingView | null = null;
    private columns: Column[] = [];
    private ascan: Surface;
    private echogram: Surface;
    private image = document.createElement('canvas');
    private ascanHover: Hover | null = null;
    private echogramHover: Hover | null = null;
    private dirty = true;
    private textDirty = true;

    constructor(options: ViewOptions, el: ViewElements) {
        this.options = options;
        this.el = el;
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

        // Text and canvases are redrawn at most once per frame, however
        // fast the pings come in.
        const frame = () => {
            if (this.textDirty) {
                this.textDirty = false;
                this.renderReadout();
            }
            if (this.dirty) {
                this.dirty = false;
                this.draw();
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    /** Clears everything, for a new session with these options. */
    reset(options: ViewOptions): void {
        this.options = options;
        this.latest = null;
        this.columns = [];
        this.textDirty = true;
        this.invalidate();
    }

    update(ping: PingView): void {
        this.latest = ping;
        this.columns.push(this.makeColumn(ping));
        if (this.columns.length > HISTORY) {
            this.columns.shift();
        }
        this.textDirty = true;
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

    /** Distance in m of power[l] of this ping. */
    private lagDistance(ping: PingView, l: number): number {
        const { metresPerSample, rangeOffset } = this.options;
        return (l + ping.lagOffset) * metresPerSample + rangeOffset;
    }

    /** Index into ping.power (fractional) for a distance in m. */
    private lagIndex(ping: PingView, distance: number): number {
        const { metresPerSample, rangeOffset } = this.options;
        return (distance - rangeOffset) / metresPerSample - ping.lagOffset;
    }

    private makeColumn(ping: PingView): Column {
        const rows = new Float32Array(ROWS).fill(Number.NaN);
        if (ping.valid) {
            const rowSize = this.options.maxRange / ROWS;
            for (let r = 0; r < ROWS; r++) {
                const end = this.lagIndex(ping, (r + 1) * rowSize);
                if (end < 0) {
                    continue; // closer than the direct path
                }
                const from = Math.max(
                    0,
                    Math.floor(this.lagIndex(ping, r * rowSize))
                );
                const to = Math.min(
                    ping.power.length,
                    Math.max(from + 1, Math.ceil(end))
                );
                let max = Number.NaN;
                for (let i = from; i < to; i++) {
                    max = max > ping.power[i] ? max : ping.power[i];
                }
                rows[r] = toDb(max);
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
            el.pingStats.textContent = '';
            return;
        }
        if (!est) {
            el.distance.textContent = 'No echo';
            el.sigma.textContent = '';
        } else {
            el.distance.textContent = `${est.distance.toFixed(2)} m`;
            // Two separate uncertainties: of the echo's position, and of
            // this being the right echo at all.
            // The peak errors are stacked like an asymmetric ± (away from
            // the phone above, towards it below) so they take one line.
            const farther = document.createElement('span');
            farther.textContent = `+${cm(est.peak.farther)}`;
            const nearer = document.createElement('span');
            nearer.textContent = `−${cm(est.peak.nearer)}`;
            const stack = document.createElement('span');
            stack.className = 'pm-stack';
            stack.append(farther, nearer);
            el.sigma.replaceChildren(`± ${cm(est.sigma)} · peak `, stack);
        }
        // The top bar keeps only what qualifies the reading itself: how sure
        // it is the right echo, and whether the latest ping was heard at all
        // (otherwise the reading is stale). The rest goes under the A-scan.
        const parts: string[] = [];
        if (est) {
            parts.push(
                `confidence ${(100 * est.peak.confidence).toFixed(0)} %`
            );
            if (est.peak.rival !== null && est.peak.confidence < 0.995) {
                parts.push(`else ${est.peak.rival.toFixed(2)} m`);
            }
        }
        if (!ping.valid) {
            parts.push('ping not heard');
        }
        el.details.textContent = parts.join(' · ');

        const stats: string[] = [];
        if (ping.valid) {
            stats.push(
                ping.levelDb === null
                    ? 'no echo this ping'
                    : `echo ${ping.levelDb.toFixed(1)} dB`
            );
        }
        if (est) {
            stats.push(
                `± from scatter ${cm(est.sigmaStat)}, ` +
                    `sound speed ${cm(est.sigmaSound)}`
            );
        }
        if (ping.latencyMs !== null) {
            stats.push(`audio latency ${ping.latencyMs.toFixed(0)} ms`);
        }
        el.pingStats.textContent = stats.join(' · ');
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

    /** Traces values[l] (a power per lag) of the ping as a path, in dB over distance. */
    private tracePower(
        ctx: CanvasRenderingContext2D,
        ping: PingView,
        values: Float32Array,
        xScale: (d: number) => number,
        yScale: (db: number) => number,
        from = 0
    ): void {
        ctx.beginPath();
        for (let l = from; l < values.length; l++) {
            const x = xScale(this.lagDistance(ping, l));
            const y = yScale(Math.max(DB_FLOOR - 1, toDb(values[l])));
            if (l === from) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
    }

    private drawAscan(): void {
        const s = this.ascan;
        const t = this.theme;
        s.begin(t);
        const { ctx } = s;
        const p = s.plot;
        const ping = this.latest;
        const { minRange, maxRange, rangeOffset, metresPerSample } =
            this.options;

        const xScale = (d: number) => p.x + (d / maxRange) * p.w;
        const yScale = (db: number) => p.y + (db / DB_FLOOR) * p.h;
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

        // Too close to tell an echo from the phone's own response.
        ctx.fillStyle = t.textMuted;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(p.x, p.y, xScale(minRange) - p.x, p.h);
        ctx.globalAlpha = 1;

        if (ping?.valid) {
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

            // What an echo has to exceed, from where echoes are searched.
            ctx.strokeStyle = t.textMuted;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            this.tracePower(
                ctx,
                ping,
                ping.threshold,
                xScale,
                yScale,
                Math.ceil((minRange - rangeOffset) / metresPerSample)
            );
            ctx.setLineDash([]);

            ctx.strokeStyle = t.series1;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            this.tracePower(ctx, ping, ping.power, xScale, yScale);

            if (ping.distance !== null && ping.levelDb !== null) {
                this.dot(
                    ctx,
                    xScale(ping.distance),
                    yScale(Math.max(DB_FLOOR, ping.levelDb)),
                    t.series1
                );
            }
        }
        ctx.restore();

        this.ascanTooltip(p, xScale, yScale);
    }

    private ascanTooltip(
        p: { x: number; y: number; w: number; h: number },
        xScale: (d: number) => number,
        yScale: (db: number) => number
    ): void {
        const tip = this.el.ascanTip;
        const ping = this.latest;
        const hover = this.ascanHover;
        if (!ping?.valid || !hover || hover.x < p.x || hover.x > p.x + p.w) {
            tip.hidden = true;
            return;
        }
        const { ctx } = this.ascan;
        const d = ((hover.x - p.x) / p.w) * this.options.maxRange;
        const i = Math.round(this.lagIndex(ping, d));
        if (i < 0 || i >= ping.power.length) {
            tip.hidden = true;
            return;
        }
        const db = toDb(ping.power[i]);
        const x = xScale(this.lagDistance(ping, i));
        const y = yScale(Math.max(DB_FLOOR, db));
        ctx.strokeStyle = this.theme.axis;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, p.y);
        ctx.lineTo(Math.round(x) + 0.5, p.y + p.h);
        ctx.stroke();
        this.dot(ctx, x, y, this.theme.series1);
        const parts = [`${d.toFixed(3)} m`, `${db.toFixed(1)} dB`];
        if (i < ping.threshold.length) {
            parts.push(`threshold ${toDb(ping.threshold[i]).toFixed(1)} dB`);
        }
        this.showTip(tip, this.ascan, x, y, parts.join(' · '));
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
                    // A lone point still shows, as a dot.
                    ctx.moveTo(x - 0.01, y);
                    ctx.lineTo(x, y);
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

function cm(metres: number): string {
    const v = metres * 100;
    return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} cm`;
}
