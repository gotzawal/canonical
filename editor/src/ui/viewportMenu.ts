import type { Store } from '../core/store';
import { VIEWPORT_FPS, VIEWPORT_QUALITY } from '../engine/runtime';
import type { MenuItem } from './overlays';

/**
 * The viewport's frame rate limit and resolution: in the View menu (two
 * submenus), and on the frame rate in the status bar (`flat`: one list).
 */
export function viewportMenu(store: Store, flat = false): MenuItem[] {
    const rates: MenuItem[] = VIEWPORT_FPS.map(({ value, label }) => ({ label, checked: () => store.prefs.viewportFps === value, action: () => store.setPrefs({ viewportFps: value }) }));
    const qualities: MenuItem[] = VIEWPORT_QUALITY.map(({ value, name, detail }) => ({
        label: `${name}${flat ? ' Quality' : ''} (${detail})`,
        checked: () => store.prefs.viewportQuality === value,
        action: () => store.setPrefs({ viewportQuality: value }),
    }));
    if (flat) return [...rates, { separator: true }, ...qualities];
    return [
        { label: 'Viewport Frame Rate', submenu: rates },
        { label: 'Viewport Quality', submenu: qualities },
    ];
}

/** "30 fps, low quality": the viewport's settings in words. */
export function viewportSummary(store: Store): string {
    const fps = store.prefs.viewportFps;
    const quality = VIEWPORT_QUALITY.find((q) => q.value === store.prefs.viewportQuality)!;
    return `${fps ? `at most ${fps} frames per second` : 'as fast as the display refreshes'} in ${quality.name.toLowerCase()} quality (${quality.detail})`;
}
