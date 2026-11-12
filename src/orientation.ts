// Compass direction of the phone from the device orientation sensors, for
// the map. Works in Chrome and Firefox on Android; iOS Safari asks for
// permission first.

/** Safari's additions to the standard event. */
interface OrientationEvent extends DeviceOrientationEvent {
    webkitCompassHeading?: number;
}

interface PermissionApi {
    requestPermission?: () => Promise<'granted' | 'denied'>;
}

/**
 * Direction of the phone's top edge in degrees clockwise (seen from above),
 * from the event's rotation about the vertical axis. Only differences
 * matter for the map, so it does not need to be relative to north. With the
 * phone held upright rather than flat, alpha becomes unreliable.
 */
export function headingOf(e: OrientationEvent): number | null {
    if (typeof e.webkitCompassHeading === 'number') {
        return e.webkitCompassHeading;
    }
    if (e.alpha === null) {
        return null;
    }
    // alpha counts counter-clockwise.
    return (360 - e.alpha) % 360;
}

/**
 * Reports the heading whenever it changes. Must be called from a user
 * gesture (iOS). Returns a function that stops the reports, or null if
 * orientation is not available or not permitted.
 */
export async function watchHeading(
    onHeading: (degrees: number) => void
): Promise<(() => void) | null> {
    if (typeof DeviceOrientationEvent === 'undefined') {
        return null;
    }
    const api = DeviceOrientationEvent as unknown as PermissionApi;
    if (api.requestPermission) {
        try {
            if ((await api.requestPermission()) !== 'granted') {
                return null;
            }
        } catch {
            return null;
        }
    }
    const listener = (e: DeviceOrientationEvent) => {
        const heading = headingOf(e);
        if (heading !== null) {
            onHeading(heading);
        }
    };
    window.addEventListener('deviceorientation', listener);
    return () => window.removeEventListener('deviceorientation', listener);
}
