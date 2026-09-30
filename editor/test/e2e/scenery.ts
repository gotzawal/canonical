// Changing the environment in the page, and the post effects it runs.
import { type Page } from '@playwright/test';
import type { EnvironmentDoc } from '../../src/core/types';

export type EnvPatch = { [K in keyof EnvironmentDoc]?: EnvironmentDoc[K] extends object ? Partial<EnvironmentDoc[K]> : EnvironmentDoc[K] };

export function setEnv(page: Page, patch: EnvPatch) {
    return page.evaluate((patch) => {
        const store = window.__editor.store;
        store.commit('Environment', (d) => {
            for (const [k, v] of Object.entries(patch)) {
                const cur = (d.environment as any)[k];
                (d.environment as any)[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...cur, ...v } : v;
            }
        }, { env: true });
    }, patch as any);
}

/** The post effects in the order they run, with whether each is on. */
export function chain(page: Page): Promise<[string, boolean][]> {
    return page.evaluate(() => {
        const pass = (window.__editor.runtime.view.renderGraph as any).getPass('PostPass');
        return Array.from(pass.postList.entries() as Iterable<[string, any]>).map(([name, post]) => [name, !!post.enable] as [string, boolean]);
    });
}
