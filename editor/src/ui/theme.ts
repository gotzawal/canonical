import type { Prefs } from '../core/store';

// Glass or solid surfaces: styles.css draws glass unless :root has .solid.

/** Without blur, translucent surfaces over the 3D view are hard to read. */
const canBlur = CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)');

/** The View menu's choice; by default glass unless the system asks for less transparency. */
export function glassOn(prefs: Prefs): boolean {
    return canBlur && (prefs.glass ?? !matchMedia('(prefers-reduced-transparency: reduce)').matches);
}

export function applyTheme(prefs: Prefs) {
    document.documentElement.classList.toggle('solid', !glassOn(prefs));
}
