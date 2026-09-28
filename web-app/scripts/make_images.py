"""Generate the PWA icons and the social (Open Graph) image into web-app/public.

Run once after changing the brand:  python scripts/make_images.py
Needs Pillow. Uses Georgia if present (Windows), else Pillow's default font.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PUBLIC = Path(__file__).resolve().parent.parent / "public"
GREEN = (35, 62, 49)
GREEN2 = (49, 83, 62)
GOLD = (191, 143, 77)
CREAM = (246, 241, 231)
PAPER = (255, 252, 246)
INK = (35, 45, 39)


def font(names, size):
    for name in names:
        for base in (Path("C:/Windows/Fonts"), Path("/usr/share/fonts/truetype/dejavu")):
            p = base / name
            if p.exists():
                return ImageFont.truetype(str(p), size)
    return ImageFont.load_default(size)


def pawn(draw, cx, cy, s, fill):
    """The brand mark: a pawn, drawn in a 24-unit box centred on (cx, cy), scale s."""
    u = s / 24
    x0, y0 = cx - 12 * u, cy - 12 * u
    P = lambda x, y: (x0 + x * u, y0 + y * u)  # noqa: E731
    draw.ellipse([P(9, 1), P(15, 7)], fill=fill)
    draw.polygon([P(8.5, 6.6), P(15.5, 6.6), P(17.7, 10), P(6.3, 10)], fill=fill)
    draw.polygon([P(7, 11), P(17, 11), P(15.8, 16), P(8.2, 16)], fill=fill)
    draw.rounded_rectangle([P(6, 17), P(18, 20.5)], radius=u, fill=fill)


def icon(size, maskable=False):
    img = Image.new("RGB", (size, size), GREEN)
    d = ImageDraw.Draw(img)
    if not maskable:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=GREEN)
    mark = size * (0.52 if maskable else 0.66)
    pawn(d, size / 2, size / 2 + size * 0.02, mark, GOLD)
    return img


def og():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    # Board motif on the right.
    sq = 58
    bx, by = W - 8 * sq - 60, (H - 8 * sq) // 2
    for r in range(8):
        for c in range(8):
            col = (125, 154, 128) if (r + c) % 2 else (239, 231, 214)
            d.rectangle([bx + c * sq, by + r * sq, bx + (c + 1) * sq, by + (r + 1) * sq], fill=col)
    d.rectangle([bx - 8, by - 8, bx + 8 * sq + 8, by + 8 * sq + 8], outline=PAPER, width=8)
    pawn(d, bx + 4.5 * sq, by + 3.5 * sq, sq * 1.1, GREEN)
    pawn(d, bx + 2.5 * sq, by + 5.5 * sq, sq * 1.1, PAPER)
    # Text.
    serif_b = font(["georgiab.ttf", "DejaVuSerif-Bold.ttf"], 80)
    serif_i = font(["georgiai.ttf", "DejaVuSerif-Italic.ttf"], 80)
    sans = font(["segoeui.ttf", "DejaVuSans.ttf"], 30)
    sans_b = font(["segoeuib.ttf", "DejaVuSans-Bold.ttf"], 26)
    x = 70
    pawn(d, x + 26, 110, 56, GOLD)
    d.text((x + 64, 86), "CHRONAEL", font=sans_b, fill=GREEN)
    d.text((x, 170), "Learn chess,", font=serif_b, fill=GREEN)
    d.text((x, 275), "calmly.", font=serif_i, fill=GOLD)
    for i, line in enumerate(["A kind coach explains every move", "in plain English. Daily puzzles.", "Play friends anywhere. Free."]):
        d.text((x, 410 + i * 42), line, font=sans, fill=INK)
    return img


def main():
    icons = PUBLIC / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    icon(192).save(icons / "icon-192.png")
    icon(512).save(icons / "icon-512.png")
    icon(512, maskable=True).save(icons / "icon-maskable-512.png")
    icon(180, maskable=True).save(icons / "apple-touch-icon.png")
    og().save(PUBLIC / "og.png", optimize=True)
    print("wrote icons and og.png")


if __name__ == "__main__":
    main()
