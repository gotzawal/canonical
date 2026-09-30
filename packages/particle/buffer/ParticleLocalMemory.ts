import { Ctor } from "@orillusion/core";
import { ParticleData } from '../data/ParticleData';
import { ParticleBuffer } from './ParticleBuffer';

/**
 * @internal
 * particle data for each quad
 * @group Plugin
 */
export class ParticleLocalMemory extends ParticleBuffer {
    public particlesData: ParticleData[] = [];

    public onChange: boolean = false;

    public allocationParticle<T extends ParticleData>(count: number, c: Ctor<T>): void {
        if (this.particlesData.length >= count) {
            return
        }

        for (let i = this.particlesData.length; i < count; i++) {
            let pd = c[`generateParticleData`]();
            this.particlesData.push(pd);
        }
        let singleCount = this.particlesData.length > 0 ? this.particlesData[0].totalCount : 0;

        // createBuffer takes 4-byte words. The slots are rounded up to whole
        // workgroups of 64: the simulation runs a thread for every slot of a
        // workgroup, and the last ones must stay inside the buffer.
        let words = Math.max(singleCount * Math.ceil(count / 64) * 64, 8);
        if (this.byteSize == undefined || this.byteSize < words * 4) {
            this.createBuffer(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, words);
        }
        this.reset();

        for (let i = 0; i < count; i++) {
            const pd = this.particlesData[i];
            pd.memoryList.forEach((v) => {
                this.memory.allocation_memory(v);
            });
            // pd.memoryList.length = 0;
            // pd.memoryList = null;
        }

        this.onChange = true;
    }
}
