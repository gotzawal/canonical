import { BoundingBox, GeometryBase, Matrix4, Transform, Vector3, VertexAttributeName } from "@orillusion/core";

/** A blade's shape: its width at each row from root to tip (times the blade width), and how much it bends. */
export interface GrassBladeShape {
    profile: ArrayLike<number>;
    curvature: number;
}

/**
 * The blades of a field in one shape: each a strip of `segmentH` rows,
 * placed by its own transform (nodes). Each blade's sub-mesh has three
 * levels of detail: every row, every other row, and root to tip alone.
 */
export class GrassGeometry extends GeometryBase {
    public width: number;
    public height: number;
    public segmentW: number;
    public segmentH: number;
    public nodes: Transform[];
    private positions: Float32Array;
    private weights: Float32Array;

    constructor(width: number, height: number, segmentW: number = 1, segmentH: number = 1, count: number) {
        super();
        this.width = width;
        this.height = height;
        this.segmentW = segmentW;
        this.segmentH = segmentH;
        this.nodes = [];
        this.buildGrass(count);
    }

    /**
     * Also gives back the matrix slots of the blades' transforms, which
     * belong to no object (Transform.destroy needs one): without this every
     * rebuilt field keeps its old blades' slots.
     */
    public destroy(force?: boolean) {
        for (const node of this.nodes ?? []) Matrix4.freeIndex(node._worldMatrix);
        this.nodes = [];
        super.destroy(force);
    }

    private buildGrass(count: number) {
        var tw: number = this.segmentW + 1;
        var singleCont: number = tw * (this.segmentH + 1);
        let vertexCount = singleCont * count;
        let position_arr = new Float32Array(vertexCount * 3);
        let normal_arr = new Float32Array(vertexCount * 3);
        let uv_arr = new Float32Array(vertexCount * 2);
        let weights_arr = new Float32Array(vertexCount * 4);
        let modelID_arr = new Float32Array(vertexCount);

        // The rows each level of detail draws: all, every other one (and the tip), root and tip.
        const levels: number[][] = [
            Array.from({ length: this.segmentH + 1 }, (_, i) => i),
            [...Array.from({ length: this.segmentH + 1 }, (_, i) => i).filter((i) => i % 2 === 0 && i < this.segmentH), this.segmentH],
            [0, this.segmentH],
        ];
        const levelQuads = levels.map((rows) => (rows.length - 1) * this.segmentW);
        let indexes: Uint32Array = new Uint32Array(levelQuads.reduce((a, b) => a + b, 0) * 6 * count);
        const levelStart: number[] = [];
        {
            let at = 0;
            for (const q of levelQuads) {
                levelStart.push(at);
                at += q * 6 * count;
            }
        }
        var indexP: number = 0;
        var indexN: number = 0;
        var indexU: number = 0;
        var indexW: number = 0;
        var indexI: number = 0;
        let cacheIndex = 0;

        let pi = 3.1415926 * 0.5;
        this.positions = position_arr;
        this.weights = weights_arr;
        for (let gi = 0; gi < count; gi++) {
            let node = new Transform();
            this.nodes.push(node);

            let dir = new Vector3(1 * Math.random() - 0.5, 0.0, 1 * Math.random() - 0.5);
            let curvature = 0.5 * Math.random();

            for (var yi: number = 0; yi <= this.segmentH; ++yi) {
                for (var xi: number = 0; xi <= this.segmentW; ++xi) {
                    let weight = yi / this.segmentH;
                    let x = this.width * (xi / this.segmentW);
                    let y = this.height * (weight);
                    position_arr[indexP++] = (x - this.width * 0.5) * (1.0 - weight);
                    position_arr[indexP++] = 0;
                    position_arr[indexP++] = 0;

                    normal_arr[indexN++] = 0;
                    normal_arr[indexN++] = 0;
                    normal_arr[indexN++] = 1;

                    uv_arr[indexU++] = xi / this.segmentW;
                    uv_arr[indexU++] = 1.0 - yi / this.segmentH;

                    weights_arr[indexW++] = dir.x;
                    weights_arr[indexW++] = dir.y;
                    weights_arr[indexW++] = dir.z;
                    weights_arr[indexW++] = curvature;

                    modelID_arr[indexI++] = node.worldMatrix.index;
                }
            }

            levels.forEach((rows, l) => {
                let k = levelStart[l] + gi * levelQuads[l] * 6;
                for (let r = 0; r + 1 < rows.length; r++) {
                    for (let j = 0; j < this.segmentW; j++) {
                        const base = j + rows[r] * tw + cacheIndex;
                        const up = j + rows[r + 1] * tw + cacheIndex;
                        indexes[k++] = base + 1;
                        indexes[k++] = base;
                        indexes[k++] = up;
                        indexes[k++] = base + 1;
                        indexes[k++] = up;
                        indexes[k++] = up + 1;
                    }
                }
            });

            cacheIndex += singleCont;
        }

        this.setIndices(indexes);
        this.setAttribute(VertexAttributeName.position, position_arr);
        this.setAttribute(VertexAttributeName.normal, normal_arr);
        this.setAttribute(VertexAttributeName.uv, uv_arr);
        this.setAttribute(VertexAttributeName.TEXCOORD_1, uv_arr);
        this.setAttribute(VertexAttributeName.vIndex, modelID_arr);
        this.setAttribute(VertexAttributeName.weights0, weights_arr);

        this.addSubGeometry(...levelQuads.map((q, l) => ({
            indexStart: levelStart[l],
            indexCount: q * 6 * count,
            vertexStart: 0,
            index: 0,
            vertexCount: 0,
            firstStart: 0,
            topology: 0
        })));

        this.bounds = new BoundingBox(Vector3.ZERO, new Vector3(9999, 9999, 9999));
    }

    /** Gives every blade its shape (its width along it and its bend), and sends the changed vertices to the GPU. */
    public reshape(shapeOf: (blade: number) => GrassBladeShape) {
        const tw = this.segmentW + 1;
        const per = tw * (this.segmentH + 1);
        const pos = this.positions;
        const wts = this.weights;
        for (let gi = 0; gi < this.nodes.length; gi++) {
            const shape = shapeOf(gi);
            for (let yi = 0; yi <= this.segmentH; yi++) {
                const w = shape.profile[Math.min(yi, shape.profile.length - 1)] ?? 0;
                for (let xi = 0; xi <= this.segmentW; xi++) {
                    const v = gi * per + yi * tw + xi;
                    pos[v * 3] = (this.width * (xi / this.segmentW) - this.width * 0.5) * w;
                    wts[v * 4 + 3] = shape.curvature;
                }
            }
        }
        const p = this.getAttribute(VertexAttributeName.position);
        const g = this.getAttribute(VertexAttributeName.weights0);
        if (this.vertexBuffer) {
            this.vertexBuffer.upload(VertexAttributeName.position, p);
            this.vertexBuffer.upload(VertexAttributeName.weights0, g);
        }
    }
}