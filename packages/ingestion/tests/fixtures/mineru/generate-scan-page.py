# One-time 04B-3 fixture generator (generator-of-record for scan-page.png):
# rasterize marker text to PNG so the fixture's middle page carries REAL
# raster-only text and no extractable text layer. Deterministic content.
# Run with any Python that has Pillow, e.g. the benchmark MinerU venv.
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1240, 1754  # A4 @ ~150dpi
img = Image.new("RGB", (W, H), "white")
draw = ImageDraw.Draw(img)
font = ImageFont.truetype(os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "arial.ttf"), 44)

lines = [
    "MINERU REAL SCAN MARKER",
    "",
    "KV93 DURABILITY LANTERN ORBIT",
    "This raster page carries no extractable text layer.",
    "The OCR engine must recover every marker word:",
    "DURABILITY LANTERN ORBIT FALCON MERIDIAN",
    "",
    "Paragraph two of the scanned fixture body.",
    " deterministic synthetic content only, no copyrighted",
    "material. Second sentence of paragraph two ends here.",
    "",
    "Paragraph three confirms recovery of body prose from",
    "rasterized glyphs by the pinned local MinerU runtime.",
]
y = 160
for line in lines:
    draw.text((110, y), line, fill="black", font=font)
    y += 92

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scan-page.png")
img.save(out)
print("PNG written", out, img.size)
