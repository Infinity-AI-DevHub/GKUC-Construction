"""Regenerates the served brand assets from the master artwork.

    python3 brand/generate.py

The master is one square image holding three stacked bands: the mark, the red
"G.K.U.C." wordmark and the black subtitle. The bands are found by looking for rows
that carry no opaque pixels, so this keeps working if the artwork is re-exported at a
different size or with different padding.
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'brand', 'gkuc-logo-master.png')
OUT = os.path.join(ROOT, 'frontend', 'public', 'brand')


def bands(alpha, step=10):
    """Vertical runs of rows that contain something."""
    w, h = alpha.size
    px = alpha.load()
    found, start = [], None
    for y in range(0, h, step):
        filled = any(px[x, y] > 20 for x in range(0, w, step))
        if filled and start is None:
            start = y
        elif not filled and start is not None:
            found.append((start, y))
            start = None
    if start is not None:
        found.append((start, h))
    return found


def save(img, name, width):
    img = img.crop(img.split()[3].getbbox())
    height = round(img.height * width / img.width)
    path = os.path.join(OUT, name)
    img.resize((width, height), Image.LANCZOS).save(path, optimize=True)
    print(f'{name:24} {width}x{height}  {os.path.getsize(path) / 1024:6.1f} KB')


def main():
    os.makedirs(OUT, exist_ok=True)
    im = Image.open(SRC).convert('RGBA')
    top, _bottom = bands(im.split()[3])[0], None
    mark = im.crop((0, top[0], im.width, top[1]))
    for w in (64, 128, 256, 512):
        save(mark, f'gkuc-mark-{w}.png', w)
    for w in (512, 1024):
        save(im, f'gkuc-logo-{w}.png', w)


if __name__ == '__main__':
    main()
