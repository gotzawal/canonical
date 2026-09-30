import { describe, expect, it } from 'vitest';
import { Input, keyNames } from '../../src/play/input';

const ev = (key: string, code: string, repeat = false) => ({ key, code, repeat }) as KeyboardEvent;

describe('Input', () => {
    it('names letter keys by where they are, whatever the input language types', () => {
        expect(keyNames(ev('w', 'KeyW'))).toEqual(['w', 'keyw']);
        expect(keyNames(ev('ㅈ', 'KeyW'))).toEqual(['w', 'ㅈ', 'keyw']);
        expect(keyNames(ev('Process', 'KeyA'))).toEqual(['a', 'process', 'keya']);
        expect(keyNames(ev('ArrowUp', 'ArrowUp'))).toEqual(['arrowup']);
        expect(keyNames(ev(' ', 'Space'))).toEqual(['space']);
    });

    it('walks with WASD on a Korean layout and lets go of the key it pressed', () => {
        const input = new Input();
        input.keyEvent(ev('ㅈ', 'KeyW'), true);
        input.keyEvent(ev('ㅁ', 'KeyA'), true);
        expect(input.axis('vertical')).toBe(1);
        expect(input.axis('horizontal')).toBe(-1);
        // An IME can name the key differently on the way up.
        input.keyEvent(ev('w', 'KeyW'), false);
        input.keyEvent(ev('Process', 'KeyA'), false);
        expect(input.axis('vertical')).toBe(0);
        expect(input.axis('horizontal')).toBe(0);
        expect(input.key('ㅈ')).toBe(false);
    });
});
