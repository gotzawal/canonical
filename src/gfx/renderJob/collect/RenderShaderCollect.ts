import { RenderNode } from "../../../components/renderer/RenderNode";
import { View3D } from "../../../core/View3D";


export type RenderShaderList = Map<string, Map<string, RenderNode>>;

/**
 * Per-view registry of renderable nodes indexed by their shader passes.
 * Groups {@link RenderNode}s by geometry+pass key so the renderer can
 * batch draws that share the same pipeline, and keeps a flat per-view
 * node lookup by instance id.
 *
 * Nodes that share a geometry and a material share keys: membership is
 * kept per node, so removing one node (or moving it to another material)
 * leaves the others under the key. The per-frame pre-init walk applies a
 * shared material's changes through whichever member it finds first.
 *
 * @group GFX
 */
export class RenderShaderCollect {
    /** Per-view map of `geometry+pass` key to the nodes drawn with that pass. */
    public renderShaderUpdateList: Map<View3D, RenderShaderList> = new Map<View3D, RenderShaderList>();
    /** Per-view flat lookup of every render node by its instance id. */
    public renderNodeList: Map<View3D, Map<string, RenderNode>> = new Map<View3D, Map<string, RenderNode>>();
    /** The view and keys each node was last added under. */
    private _membership: Map<string, { view: View3D; keys: string[] }> = new Map();

    /** Register `node` (and all its material passes) into this view's render lists. */
    public collect_add(node: RenderNode) {
        let view = node.transform.view3D;
        // Leave the keys of its previous geometry / materials first.
        this.collect_remove(node);
        if (view && node.materials && node.geometry) {
            let rDic = this.renderShaderUpdateList.get(view);
            if (!rDic) {
                rDic = new Map<string, Map<string, RenderNode>>();
                this.renderShaderUpdateList.set(view, rDic);
            }
            let renderGlobalMap = this.renderNodeList.get(view);
            if (!renderGlobalMap) {
                renderGlobalMap = new Map<string, RenderNode>();
                this.renderNodeList.set(view, renderGlobalMap);
            }
            renderGlobalMap.set(node.instanceID, node);

            const keys: string[] = [];
            node.materials.forEach((mat) => {
                let colorPassList = mat.getAllPass();
                for (let i = 0; i < colorPassList.length; i++) {
                    const pass = colorPassList[i];
                    let key = `${node.geometry.instanceID + pass.instanceID}`
                    let nodeMap = rDic.get(key);
                    if (!nodeMap) {
                        nodeMap = new Map<string, RenderNode>();
                        rDic.set(key, nodeMap);
                    }
                    nodeMap.set(node.instanceID, node);
                    keys.push(key);
                }
            });
            this._membership.set(node.instanceID, { view, keys });
        }
    }

    /** Remove `node` from the keys it was added under (other nodes sharing them stay). */
    public collect_remove(node: RenderNode) {
        const member = this._membership.get(node.instanceID);
        if (!member) return;
        this._membership.delete(node.instanceID);
        const rDic = this.renderShaderUpdateList.get(member.view);
        if (rDic) {
            for (const key of member.keys) {
                const nodeMap = rDic.get(key);
                if (!nodeMap) continue;
                nodeMap.delete(node.instanceID);
                if (nodeMap.size === 0) rDic.delete(key);
            }
        }
        this.renderNodeList.get(member.view)?.delete(node.instanceID);
    }

    /** Drop all entries for `view` (called on view/engine teardown). */
    public removeView(view: View3D) {
        this.renderShaderUpdateList.delete(view);
        this.renderNodeList.delete(view);
        for (const [id, member] of this._membership) if (member.view === view) this._membership.delete(id);
    }
}
