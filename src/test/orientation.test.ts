import { describe, expect, it } from 'vitest';
import { headingOf } from '../orientation';

const event = (init: object) => init as DeviceOrientationEvent;

describe('headingOf', () => {
    it('turns the counter-clockwise alpha into a clockwise heading', () => {
        expect(headingOf(event({ alpha: 0 }))).toBe(0);
        expect(headingOf(event({ alpha: 90 }))).toBe(270);
        expect(headingOf(event({ alpha: 350 }))).toBe(10);
    });

    it("prefers Safari's compass heading", () => {
        expect(headingOf(event({ alpha: 90, webkitCompassHeading: 123 }))).toBe(
            123
        );
    });

    it('is null without a sensor', () => {
        expect(headingOf(event({ alpha: null }))).toBeNull();
    });
});
