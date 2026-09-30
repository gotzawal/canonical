// What a game built from the scene downloads for its assets, per asset: the
// compressed copy the build ships where a fresh one is stored (textures as
// KTX2, models packed), else the file. Read from what this browser keeps,
// without making copies: an asset whose copy is not made yet counts as its
// file until the background compression (or the next build) makes it.

import { derivedKey, derivedOptions, getDerived, isFresh, shipsAsIs, shipsCopy, type DerivedRole } from '../core/derived';
import { usedAssetIds } from '../core/persistence';
import { assetRoles } from '../core/refs';
import type { AssetKind, SceneDoc } from '../core/types';

const TEXTURE_ROLES: readonly string[] = ['color', 'normal', 'data'];

export interface AssetSize {
    id: string;
    name: string;
    kind: AssetKind;
    /** The stored file. */
    file: number;
    /** What the game downloads for it. */
    shipped: number;
    /** The file as it is, its compressed copy, or the file until a copy is made. */
    how: 'file' | 'copy' | 'pending';
}

/** The assets the scene uses, largest download first. */
export async function assetSizes(doc: SceneDoc): Promise<AssetSize[]> {
    const used = usedAssetIds(doc);
    const roles = assetRoles(doc);
    const out: AssetSize[] = [];
    for (const a of doc.assets) {
        if (!used.has(a.id)) continue;
        const file = a.size || 0;
        const row: AssetSize = { id: a.id, name: a.name, kind: a.kind, file, shipped: file, how: 'file' };
        out.push(row);
        if (shipsAsIs(a)) continue;
        if (a.kind === 'texture') {
            const all = [...(roles.get(a.id) ?? [])];
            const textureRoles = all.filter((r) => TEXTURE_ROLES.includes(r)) as DerivedRole[];
            if (!textureRoles.length) continue;
            // Like the build: a copy per role, and the file too when shader code may load it.
            let bytes = 0;
            let covered = textureRoles.length === all.length;
            let pending = false;
            for (const role of textureRoles) {
                const opts = derivedOptions(role, a.compress);
                const rec = opts ? await getDerived(derivedKey(a.id, role)) : null;
                if (opts && isFresh(rec, a, opts)) bytes += rec.bytes;
                else {
                    covered = false;
                    if (opts) pending = true;
                }
            }
            row.shipped = bytes + (covered ? 0 : file);
            row.how = pending ? 'pending' : bytes ? 'copy' : 'file';
        } else if (a.kind === 'model') {
            const opts = derivedOptions('model', a.compress);
            if (!opts) continue;
            const rec = await getDerived(derivedKey(a.id, 'model'));
            if (!isFresh(rec, a, opts)) row.how = 'pending';
            else if (shipsCopy(rec, a)) {
                row.shipped = rec.bytes;
                row.how = 'copy';
            }
        }
    }
    return out.sort((x, y) => y.shipped - x.shipped);
}
