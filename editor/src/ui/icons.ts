// Hand-drawn 24x24 stroke icons used across the editor UI.

const PATHS: Record<string, string> = {
    cube: '<path d="M12 3 20 7.5v9L12 21 4 16.5v-9Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
    sphere: '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="8.5" ry="3.2"/>',
    plane: '<path d="M3 15 9 8h12l-6 7Z"/>',
    cylinder: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>',
    torus: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/>',
    empty: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4"/><circle cx="12" cy="12" r="1.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
    bulb: '<path d="M9 17h6M10 20.5h4M8.2 14.2A6 6 0 1 1 15.8 14.2c-.6.6-.8 1.3-.8 2V17H9v-.8c0-.7-.2-1.4-.8-2Z"/>',
    spot: '<path d="M8.5 3h7l3.5 9H5Z"/><path d="M8 16l-2 5M12 16v5M16 16l2 5"/>',
    model: '<path d="M12 2.8 20 7v10l-8 4.2L4 17V7Z"/><path d="M4 7l8 4.2L20 7M12 11.2v10"/><path d="m8 5 8 4.3"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-5-5-8.5 8.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.7 3.4M6.4 6.5A15.6 15.6 0 0 0 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    cursor: '<path d="M5 3.5 18.5 10 12 12l-2 6.5Z"/>',
    move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
    rotate: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
    scale: '<rect x="3.5" y="10.5" width="10" height="10" rx="1"/><path d="M13 4h7v7M20 4l-8 8"/>',
    grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/>',
    magnet: '<path d="M5 4h4v8a3 3 0 0 0 6 0V4h4v8A7 7 0 0 1 5 12Z"/><path d="M5 8h4M15 8h4"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5S9.6 6.1 12 3.5Z"/>',
    local: '<path d="M12 20V8M12 8 8.5 11.5M12 8l3.5 3.5"/><path d="M5 20h14"/><circle cx="12" cy="5" r="1.5"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5l1-12.5M9 7V4.5h6V7"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
    open: '<path d="M3.5 19V6a1.5 1.5 0 0 1 1.5-1.5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5V10"/><path d="M3.5 19 6.5 11h16l-3 8Z"/>',
    save: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 16v2.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 16v2.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    focus: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.01"/>',
    alert: '<path d="M12 3.5 21.5 20h-19Z"/><path d="M12 10v4.5M12 17.2v.01"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6.5 14.5h11"/>',
    github: '<path d="M9 19c-4 1.3-4-2-5.5-2.5M14.5 21v-3.4c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.7 4.7 0 0 0-1.3-3.2 4.4 4.4 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.1 3 5.1 3.3 5.1 3.3A4.4 4.4 0 0 0 5 6.4a4.7 4.7 0 0 0-1.3 3.2c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
    play: '<path d="M7 4.5v15l12-7.5Z"/>',
    home: '<path d="M4 11 12 4l8 7M6 9.5V20h12V9.5"/>',
    dots: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
};

export type IconName = keyof typeof PATHS;

export function icon(name: string, size = 16, cls = ''): SVGSVGElement {
    const wrap = document.createElement('span');
    wrap.innerHTML =
        `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
        `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
    return wrap.firstElementChild as SVGSVGElement;
}

export function nodeIcon(node: { mesh?: { geometry: { type: string } }; light?: { type: string }; model?: unknown }): string {
    if (node.light) return node.light.type === 'directional' ? 'sun' : node.light.type === 'point' ? 'bulb' : 'spot';
    if (node.model) return 'model';
    if (node.mesh) {
        const t = node.mesh.geometry.type;
        return t === 'box' ? 'cube' : t;
    }
    return 'empty';
}
