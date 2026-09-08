#!/usr/bin/env python3
"""Generate RedstonePanel app icons (PNG, ICO, ICNS).

Uses only the Python standard library, so it runs anywhere:
    python3 scripts/make_icons.py

Output: src-tauri/icons/{icon.png, icon.ico, icon.icns, 32x32.png, 128x128.png, 128x128@2x.png}
"""
import os
import struct
import zlib

BASE = 1024  # master drawing resolution


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))


# Lucide "zap" bolt polygon (24x24 grid, already centered on 12,12)
BOLT = [(13, 2), (3, 14), (12, 14), (11, 22), (21, 10), (12, 10)]
BOLT_SCALE = 0.62  # fraction of icon size the bolt spans


def in_rounded_square(x, y, size, radius):
    m = size * 0.03
    r = radius * size
    x, y = x - m, y - m
    s = size - 2 * m
    if x < 0 or y < 0 or x > s or y > s:
        return False
    if x < r and y < r:
        return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x > s - r and y < r:
        return (x - (s - r)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y > s - r:
        return (x - r) ** 2 + (y - (s - r)) ** 2 <= r * r
    if x > s - r and y > s - r:
        return (x - (s - r)) ** 2 + (y - (s - r)) ** 2 <= r * r
    return True


def in_bolt(u, v):
    """u,v in [0,1] icon space. Returns True if inside the bolt polygon."""
    cx = (u - 0.5) * (24 / BOLT_SCALE) + 12
    cy = (v - 0.5) * (24 / BOLT_SCALE) + 12
    inside = False
    j = len(BOLT) - 1
    for i, (xi, yi) in enumerate(BOLT):
        xj, yj = BOLT[j]
        if (yi > cy) != (yj > cy) and cx < (xj - xi) * (cy - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def render(size):
    bg_top = (30, 33, 44, 255)
    bg_bot = (14, 15, 20, 255)
    bolt_top = (255, 122, 68, 255)
    bolt_bot = (216, 40, 14, 255)
    radius = 0.20
    scale = BASE / size
    rows = []
    for py in range(size):
        row = bytearray()
        sy = py * scale
        bg = lerp(bg_top, bg_bot, (sy / BASE) ** 1.15)
        for px in range(size):
            sx = px * scale
            if not in_rounded_square(sx, sy, BASE, radius):
                row += b'\x00\x00\x00\x00'
            elif in_bolt(px / size, py / size):
                glow = lerp(bolt_top, bolt_bot, (py / size) ** 1.2)
                # subtle highlight on top edge
                row += bytes(glow)
            else:
                row += bytes(bg)
        rows.append(bytes(row))
    return rows


def _png_chunk(tag, data):
    out = struct.pack('>I', len(data)) + tag + data
    out += struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    return out


def to_png(size, rows):
    raw = b''.join(b'\x00' + r for r in rows)
    return (
        b'\x89PNG\r\n\x1a\n'
        + _png_chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
        + _png_chunk(b'IDAT', zlib.compress(raw, 9))
        + _png_chunk(b'IEND', b'')
    )


def to_ico(entries):
    n = len(entries)
    header = struct.pack('<HHH', 0, 1, n)
    offset = 6 + 16 * n
    dir_entries = b''
    payload = b''
    for size, png in entries:
        dim = 0 if size >= 256 else size
        dir_entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
        payload += png
    return header + dir_entries + payload


def to_icns(entries):
    body = b''
    for tag, png in entries:
        body += tag + struct.pack('>I', 8 + len(png)) + png
    total = 8 + len(body)
    return struct.pack('>I', 4) + b'icns' + struct.pack('>I', total) + body


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           'src-tauri', 'icons')
    os.makedirs(out_dir, exist_ok=True)

    master_rows = render(BASE)
    master_png = to_png(BASE, master_rows)

    def resized(size):
        # simple box downscale of the master rows
        factor = BASE // size
        rows = []
        for y in range(size):
            row = bytearray()
            sy = y * factor
            for x in range(size):
                sx = x * factor
                px = master_rows[sy][sx * 4:sx * 4 + 4]
                row += px
            rows.append(bytes(row))
        return to_png(size, rows)

    sizes = {16: 16, 32: 32, 48: 48, 64: 64, 128: 128, 256: 256, 512: 512}
    pngs = {s: resized(s) for s in sizes}
    pngs[1024] = master_png

    with open(os.path.join(out_dir, 'icon.png'), 'wb') as f:
        f.write(pngs[512])
    with open(os.path.join(out_dir, '32x32.png'), 'wb') as f:
        f.write(pngs[32])
    with open(os.path.join(out_dir, '128x128.png'), 'wb') as f:
        f.write(pngs[128])
    with open(os.path.join(out_dir, '128x128@2x.png'), 'wb') as f:
        f.write(pngs[256])
    with open(os.path.join(out_dir, 'icon.ico'), 'wb') as f:
        f.write(to_ico([(16, pngs[16]), (32, pngs[32]), (48, pngs[48]),
                        (256, pngs[256])]))
    with open(os.path.join(out_dir, 'icon.icns'), 'wb') as f:
        f.write(to_icns([(b'ic07', pngs[128]), (b'ic08', pngs[256]),
                         (b'ic09', pngs[512]), (b'ic10', pngs[1024])]))

    print(f'icons written to {out_dir}')


if __name__ == '__main__':
    main()
