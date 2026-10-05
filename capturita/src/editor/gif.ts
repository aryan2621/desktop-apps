/**
 * A small animated-GIF encoder for exports. Each frame gets its own 256-colour palette (median
 * cut over a 15-bit histogram), so gradients and screenshots keep their colours, and is LZW
 * compressed as the format requires. Bytes are handed to `write` as they are produced.
 */
export class GifEncoder {
    private width: number;
    private height: number;
    private write: (bytes: Uint8Array) => Promise<void>;
    private started = false;

    constructor(width: number, height: number, write: (bytes: Uint8Array) => Promise<void>) {
        this.width = width;
        this.height = height;
        this.write = write;
    }

    private async header() {
        const out = new ByteWriter();
        out.text('GIF89a');
        out.u16(this.width);
        out.u16(this.height);
        out.byte(0x00); // no global colour table
        out.byte(0); // background colour index
        out.byte(0); // square pixels
        // Loop forever (NETSCAPE2.0 application extension).
        out.bytes([0x21, 0xff, 0x0b]);
        out.text('NETSCAPE2.0');
        out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
        await this.write(out.done());
    }

    /** Adds one frame of RGBA pixels shown for `delay` seconds. */
    async addFrame(rgba: Uint8ClampedArray, delay: number) {
        if (!this.started) {
            this.started = true;
            await this.header();
        }
        const { palette, indices } = quantize(rgba, this.width * this.height);
        const out = new ByteWriter();
        // Graphic control extension: delay in hundredths of a second, no transparency.
        out.bytes([0x21, 0xf9, 0x04, 0x00]);
        out.u16(Math.max(2, Math.round(delay * 100)));
        out.bytes([0x00, 0x00]);
        // Image descriptor with a local 256-colour table.
        out.byte(0x2c);
        out.u16(0);
        out.u16(0);
        out.u16(this.width);
        out.u16(this.height);
        out.byte(0x80 | 0x07);
        out.bytes(palette);
        lzw(indices, 8, out);
        await this.write(out.done());
    }

    async finish() {
        if (!this.started) await this.header();
        await this.write(new Uint8Array([0x3b]));
    }
}

class ByteWriter {
    private buffer = new Uint8Array(1 << 16);
    private length = 0;
    private ensure(extra: number) {
        if (this.length + extra <= this.buffer.length) return;
        let size = this.buffer.length * 2;
        while (size < this.length + extra) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buffer.subarray(0, this.length));
        this.buffer = next;
    }
    byte(value: number) {
        this.ensure(1);
        this.buffer[this.length++] = value & 0xff;
    }
    u16(value: number) {
        this.byte(value);
        this.byte(value >> 8);
    }
    bytes(values: ArrayLike<number>) {
        this.ensure(values.length);
        for (let i = 0; i < values.length; i++) this.buffer[this.length++] = values[i] & 0xff;
    }
    text(value: string) {
        for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i));
    }
    done() {
        return this.buffer.slice(0, this.length);
    }
}

/** 256 colours for the frame (as 768 RGB bytes) and each pixel's palette index. */
function quantize(rgba: Uint8ClampedArray, pixels: number) {
    // Histogram over 5 bits per channel.
    const counts = new Uint32Array(32768);
    for (let i = 0; i < pixels; i++) {
        const p = i * 4;
        counts[((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3)]++;
    }
    const colors: number[] = [];
    for (let c = 0; c < 32768; c++) if (counts[c] > 0) colors.push(c);

    // Median cut: split the box with the widest channel range at its weighted median.
    type Box = { colors: number[]; range: number; channel: number };
    const channelOf = (c: number, ch: number) => (ch === 0 ? c >> 10 : ch === 1 ? (c >> 5) & 31 : c & 31);
    const measure = (list: number[]): Box => {
        let best = 0;
        let channel = 0;
        for (let ch = 0; ch < 3; ch++) {
            let min = 31;
            let max = 0;
            for (const c of list) {
                const v = channelOf(c, ch);
                if (v < min) min = v;
                if (v > max) max = v;
            }
            if (max - min > best) {
                best = max - min;
                channel = ch;
            }
        }
        return { colors: list, range: best, channel };
    };
    const boxes: Box[] = [measure(colors)];
    while (boxes.length < 256) {
        let index = -1;
        for (let i = 0; i < boxes.length; i++) if (boxes[i].range > 0 && (index < 0 || boxes[i].range * boxes[i].colors.length > boxes[index].range * boxes[index].colors.length)) index = i;
        if (index < 0) break;
        const box = boxes[index];
        const sorted = box.colors.slice().sort((a, b) => channelOf(a, box.channel) - channelOf(b, box.channel));
        let total = 0;
        for (const c of sorted) total += counts[c];
        let seen = 0;
        let cut = 1;
        for (let i = 0; i < sorted.length - 1; i++) {
            seen += counts[sorted[i]];
            if (seen >= total / 2) {
                cut = i + 1;
                break;
            }
            cut = i + 1;
        }
        boxes.splice(index, 1, measure(sorted.slice(0, cut)), measure(sorted.slice(cut)));
    }

    // Each box's weighted average is a palette entry; every histogram colour maps to its box.
    const palette = new Uint8Array(768);
    const lookup = new Uint8Array(32768);
    boxes.forEach((box, i) => {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const c of box.colors) {
            const w = counts[c];
            r += (c >> 10) * w;
            g += ((c >> 5) & 31) * w;
            b += (c & 31) * w;
            n += w;
            lookup[c] = i;
        }
        const to8 = (v: number) => Math.min(255, Math.round((v / Math.max(1, n)) * 8.226));
        palette[i * 3] = to8(r);
        palette[i * 3 + 1] = to8(g);
        palette[i * 3 + 2] = to8(b);
    });
    const indices = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
        const p = i * 4;
        indices[i] = lookup[((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3)];
    }
    return { palette, indices };
}

/** GIF-flavoured LZW: variable-width codes packed LSB-first into sub-blocks of up to 255 bytes. */
function lzw(indices: Uint8Array, minCodeSize: number, out: ByteWriter) {
    out.byte(minCodeSize);
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let codeSize = minCodeSize + 1;
    let next = end + 1;
    // Dictionary keyed by (prefix code << 8 | byte).
    let table = new Map<number, number>();

    const block = new Uint8Array(255);
    let blockLength = 0;
    let bits = 0;
    let bitCount = 0;
    const emit = (code: number) => {
        bits |= code << bitCount;
        bitCount += codeSize;
        while (bitCount >= 8) {
            block[blockLength++] = bits & 0xff;
            bits >>>= 8;
            bitCount -= 8;
            if (blockLength === 255) {
                out.byte(255);
                out.bytes(block);
                blockLength = 0;
            }
        }
    };

    emit(clear);
    let prefix = indices.length > 0 ? indices[0] : 0;
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        const found = table.get(key);
        if (found !== undefined) {
            prefix = found;
            continue;
        }
        emit(prefix);
        if (next < 4096) {
            table.set(key, next++);
            if (next > 1 << codeSize && codeSize < 12) codeSize++;
        } else {
            emit(clear);
            table = new Map();
            codeSize = minCodeSize + 1;
            next = end + 1;
        }
        prefix = k;
    }
    emit(prefix);
    emit(end);
    if (bitCount > 0) {
        block[blockLength++] = bits & 0xff;
        if (blockLength === 255) {
            out.byte(255);
            out.bytes(block);
            blockLength = 0;
        }
    }
    if (blockLength > 0) {
        out.byte(blockLength);
        out.bytes(block.subarray(0, blockLength));
    }
    out.byte(0);
}
