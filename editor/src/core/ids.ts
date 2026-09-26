/** Random id with a type prefix, e.g. "n_1x2y3z" for nodes. */
export function uid(prefix = 'n'): string {
    const rnd = crypto.getRandomValues(new Uint32Array(2));
    return `${prefix}_${rnd[0].toString(36)}${rnd[1].toString(36)}`;
}
