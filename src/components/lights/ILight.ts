import { Camera3D } from "../../core/Camera3D";
import { Transform } from "../Transform";
import { IESProfiles } from "./IESProfiles";
import { LightData } from "./LightData";

export interface ILight {
    name: string;
    transform: Transform;
    lightData: LightData;
    needUpdateShadow: boolean;
    realTimeShadow: boolean;
    shadowUpdate: 'auto' | 'every_frame' | 'static';
    shadowMapSize: number;
    shadowMapWidth: number;
    shadowMapHeight: number;
    _shadowSignatures: number[];

    shadowIndex: number;

    shadowCamera?: Camera3D;

    readonly iesProfile?: IESProfiles;
}