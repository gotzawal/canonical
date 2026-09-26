// The Canonical logo as one path: the disc with the blades and the centre cut
// out. It is drawn in currentColor, so on the dark UI it shows as a light disc.
// The same shape is in editor/public (favicon.svg, logo.svg, logo-white.svg).

const DISC = 'M0 512A512 512 0 1 0 1024 512A512 512 0 1 0 0 512Z';
const CUTS =
    'M477.6 116.9L477.6 384.7A131.9 131.9 0 0 0 384.7 477.6L267.1 477.6Z' +
    'M546.4 70.3A537.1 537.1 0 0 1 724 128A1236.3 1236.3 0 0 1 936.4 398.7L546.4 178.2Z' +
    'M125.9 546.4L384.7 546.4A131.9 131.9 0 0 0 477.6 639.3L477.6 750.9Z' +
    'M77.6 581L477.6 814L477.6 953.7A443 443 0 0 1 393.2 938.8Z' +
    'M546.4 907L546.4 639.3A131.9 131.9 0 0 0 639.3 546.4L757 546.4Z' +
    'M821.8 544.8L585.3 948.9A443 443 0 0 0 656.1 930.9Z' +
    'M459.7 512A52.3 52.3 0 1 0 564.3 512A52.3 52.3 0 1 0 459.7 512Z';

export function logo(size = 20, cls = ''): SVGSVGElement {
    const wrap = document.createElement('span');
    wrap.innerHTML =
        `<svg class="logo ${cls}" width="${size}" height="${size}" viewBox="0 0 1024 1024" aria-hidden="true">` +
        `<path fill="currentColor" fill-rule="evenodd" d="${DISC}${CUTS}"/></svg>`;
    return wrap.firstElementChild as SVGSVGElement;
}
