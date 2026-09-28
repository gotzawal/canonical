// The Morglay logo as one path: the disc with the blades and the centre cut
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

// The wordmark: "Morglay" set in Playfair Display ExtraBold Italic (SIL Open
// Font License 1.1) and outlined, so it looks the same on every system
// without loading the font. Font units, 1000 to the em. The box is centred on
// the capitals: in a row that centres its items the word lines up with the
// logo, and the descenders hang below.
const WORDMARK_BOX = [3865, 1118];
const WORDMARK =
    'M502 688l307-480l88 0q49 0 94-1q44-1 79-2l-5 20q-34 1-53 8q-19 6-29 24q-11 17-21 54l-132 496q-9 36-7 54q1 18 17 24q16 6 49 8l-4 20q-34-2-78-2q-45-1-94-1q-51 0-97 1q-46 0-73 2l4-20q35-2 54-8q18-6 29-24q11-18 20-54l145-539l-415 650l-22 0l-85-599l-121 461q-8 30-7 55q1 25 20 41q18 15 65 17l-4 20q-12-1-32-1q-21-1-43-1q-23-1-41-1q-25 0-51 1q-26 0-43 2l4-20q35-2 56-17q21-16 34-41q12-25 20-55l125-469q10-37 8-54q-2-18-17-24q-16-7-50-8l5-20q25 1 67 2q41 1 86 1q24 0 48-1q24-1 43-2l57 483' + // M
    'm831-287q-20 0-44 28q-25 28-49 75q-24 47-44 105q-20 58-32 119q-12 61-12 117q0 34 7 48q6 14 20 14q19 0 43-26q24-27 48-72q23-46 43-103q20-58 33-120q12-62 12-121q0-40-7-52q-7-12-18-12m-331 359q0-47 13-99q13-52 39-101q26-50 67-90q40-41 94-65q54-24 123-24q82 0 126 43q44 43 44 124q0 47-13 99q-13 52-39 102q-26 49-66 90q-41 40-95 64q-54 24-123 24q-82 0-126-43q-44-43-44-124' + // o
    'm763-81l-61 234l-159 0l122-433q7-25 5-35q-3-11-15-11q-17 0-31 16q-14 15-29 55l-21 56l-19 0l28-77q14-39 35-61q21-23 49-32q28-10 59-10q33 0 52 13q18 12 26 33q7 21 7 45q-1 24-6 46q14-34 29-59q25-43 55-60q30-18 69-18q43 0 66 26q23 25 23 63q0 30-13 57q-14 26-37 42q-24 15-54 15q-33 0-50-17q-18-17-18-50q0-27 13-50q13-24 35-40q22-17 48-22l-6-2q-3-1-7-1q-20 0-42 9q-22 9-46 37q-24 28-50 83q-27 54-56 144q-1 2-1 4' + // r
    'm543-297q45 0 79 11q13-18 31-32q34-25 73-25q33 0 50 18q17 18 17 47q0 29-15 44q-15 15-33 15q-16 0-30-12q-15-13-19-38q-3-22 8-54q-29 12-46 28q-8 8-15 18q6 3 13 6q44 27 44 87q0 48-31 95q-31 47-88 77q-35 18-77 25q-22 9-39 17q-28 14-43 25q-15 10-15 21q0 8 10 15q10 6 30 12l87 31q28 10 54 24q26 14 43 36q17 22 17 55q0 41-26 74q-27 32-72 55q-45 22-99 34q-55 11-112 11q-50 0-93-9q-43-10-69-27q-27-17-27-40q0-20 20-35q19-15 50-25q30-10 64-15q33-5 63-6l2 15q-33 18-46 37q-14 19-14 37q0 25 19 38q19 13 53 13q26 0 55-7q28-7 53-20q24-14 40-32q15-18 15-39q0-20-15-27q-15-8-40-15l-139-42q-25-8-43-24q-19-17-19-43q0-30 27-53q26-24 75-48q38-18 85-38q-5 0-10 0q-67 0-112-27q-46-27-46-86q0-34 17-69q17-36 50-66q32-31 80-49q47-18 109-18m-22 18q-14 0-27 13q-13 13-23 36q-11 22-18 50q-7 28-11 60q-4 31-4 62q0 33 7 46q6 12 19 12q20 0 36-19q15-20 26-52q11-32 16-71q5-39 5-78q0-23-4-41q-5-18-22-18' + // g
    'm579-282l-210 710q-8 25-1 36q6 10 17 10q8 0 24-12q15-12 32-59l19-52l19 0l-25 73q-15 42-38 64q-23 22-49 31q-26 8-51 8q-32 0-54-11q-22-12-33-33q-11-21-11-51q0-31 12-71l155-515q10-34-2-50q-12-16-61-16l7-21q77-1 136-11q59-11 114-30' + // l
    'm317 323l13-45q49-1 88-4q38-4 75-11l-133 447q-4 14-4 25q-1 10 4 16q4 5 13 5q11 0 26-13q15-13 32-58l19-52l19 0l-25 73q-14 41-37 64q-23 22-49 31q-26 8-52 8q-56 0-80-33q-15-22-15-55q0-16 3-36q-14 33-30 55q-27 38-59 54q-33 15-69 15q-60 0-89-33q-29-33-29-91q0-56 19-115q19-60 52-114q32-55 73-98q40-44 85-69q44-26 87-26q33 0 51 23q10 13 12 37m-185 425q12 0 27-12q15-13 31-39q16-26 33-67q17-41 33-99l-2 9l52-180q3-25-2-39q-7-15-23-15q-19 0-42 23q-23 22-46 61q-24 38-43 88q-20 49-32 104q-12 55-12 108q0 31 6 45q6 13 20 13' + // a
    'm450 185q47-22 98-62q12-9 25-21l-80-487q-4-26-9-35q-5-10-14-10q-11 0-19 13q-9 12-25 56l-20 52l-19 0l25-73q21-61 54-82q32-21 73-21q43 0 71 24q28 23 37 90l45 332q29-43 54-88q40-76 60-143q-27-15-49-36q-23-22-36-48q-13-27-13-56q0-35 20-55q19-20 52-20q38 0 55 25q17 25 17 69q0 46-16 102q-16 55-43 114q-28 59-63 115q-36 56-75 103q-37 45-78 81q-42 35-86 61q-45 25-90 39q-19 6-35 9q-17 2-30 2q-36 0-56-16q-20-16-20-45q0-28 21-47q20-20 54-20q34 0 63 20q28 20 52 58'; // y

let wordmarks = 0;

/** The wordmark at a font size of `size` px: a light tint fading into currentColor. */
export function wordmark(size = 22, cls = ''): SVGSVGElement {
    const [w, h] = WORDMARK_BOX;
    const id = `wordmark-fill-${++wordmarks}`;
    const wrap = document.createElement('span');
    wrap.innerHTML =
        `<svg class="wordmark ${cls}" width="${Math.round((w * size) / 1000)}" height="${Math.round((h * size) / 1000)}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Morglay">` +
        `<defs><linearGradient id="${id}" x2="1" y2="0.35"><stop stop-color="#f4efff"/><stop offset="0.6" stop-color="currentColor"/></linearGradient></defs>` +
        `<path fill="url(#${id})" d="${WORDMARK}"/></svg>`;
    return wrap.firstElementChild as SVGSVGElement;
}
