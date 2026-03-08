"""
Adds a diagonal "DEV" corner banner to the CreatorPost logo.
Output: public/logo-dev.png
"""
import math
from PIL import Image, ImageDraw, ImageFont

SRC = "public/logo.png"
DST = "public/logo-dev.png"
BANNER_COLOR = (220, 38, 38, 230)   # red, slightly transparent
TEXT_COLOR   = (255, 255, 255, 255)
BANNER_TEXT  = "DEV"

img = Image.open(SRC).convert("RGBA")
w, h = img.size

# Banner size: ~30% of the image width
banner_size = int(w * 0.38)

# Create a square overlay the same size as the image
overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
draw = ImageDraw.Draw(overlay)

# Draw a diagonal triangle in the top-right corner
draw.polygon(
    [(w - banner_size, 0), (w, 0), (w, banner_size)],
    fill=BANNER_COLOR
)

# Find a font — try system fonts, fall back to default
font = None
font_size = int(w * 0.11)
candidates = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNSDisplay.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]
for path in candidates:
    try:
        font = ImageFont.truetype(path, font_size)
        break
    except Exception:
        pass
if font is None:
    font = ImageFont.load_default()

# Position text diagonally in the triangle
# Rotate text -45 degrees and place in the corner
txt_img = Image.new("RGBA", (banner_size, banner_size), (0, 0, 0, 0))
txt_draw = ImageDraw.Draw(txt_img)
bbox = txt_draw.textbbox((0, 0), BANNER_TEXT, font=font)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
txt_draw.text(
    ((banner_size - tw) / 2 - 4, (banner_size - th) / 2 - 8),
    BANNER_TEXT,
    font=font,
    fill=TEXT_COLOR
)
txt_img = txt_img.rotate(45, expand=False)

# Paste the rotated text onto the overlay at the top-right
overlay.paste(txt_img, (w - banner_size, 0), txt_img)

# Composite onto original
result = Image.alpha_composite(img, overlay)
result.save(DST)
print(f"Saved {DST}")
