"""Generate Ponsr's X profile picture and banner from the site's own assets and palette."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math, os

SITE = r"C:\Users\W\Ponsr\website"
OUT  = r"C:\Users\W\Ponsr\brand"
os.makedirs(OUT, exist_ok=True)

# Palette lifted straight from the site's CSS variables
VOID     = (5, 6, 7)
INK      = (14, 18, 24)
SILVER   = (196, 205, 218)
SILVER_B = (241, 245, 250)
STEEL    = (130, 140, 155)
EMERALD  = (70, 200, 140)
EM_BRIGHT= (130, 227, 179)
MUTE     = (139, 148, 161)

F_DISPLAY = r"C:\Windows\Fonts\georgiab.ttf"   # closest system stand-in for Fraunces
F_MONO    = r"C:\Windows\Fonts\consola.ttf"


def radial(size, center, radius, color, strength=1.0):
    """Soft radial glow as an RGBA layer."""
    w, h = size
    lay = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(lay)
    steps = 48
    for i in range(steps, 0, -1):
        r = radius * i / steps
        a = int(255 * strength * ((1 - i / steps) ** 2.2))
        d.ellipse([center[0]-r, center[1]-r, center[0]+r, center[1]+r], fill=a)
    lay = lay.filter(ImageFilter.GaussianBlur(radius * 0.10))
    out = Image.new("RGBA", (w, h), color + (0,))
    out.putalpha(lay)
    return out


def backdrop(w, h, grid=True):
    """Obsidian base + drifting glows + grid + grain + vignette."""
    base = Image.new("RGB", (w, h), VOID)
    d = ImageDraw.Draw(base)
    # vertical lift toward the top, like the site's radial page background
    for y in range(h):
        t = y / h
        c = tuple(int(INK[i] * (1 - t) ** 1.6 + VOID[i] * (1 - (1 - t) ** 1.6)) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    base = base.convert("RGBA")

    if grid:
        g = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        gd = ImageDraw.Draw(g)
        step = 62
        for x in range(0, w, step):
            gd.line([(x, 0), (x, h)], fill=(150, 170, 200, 12))
        for y in range(0, h, step):
            gd.line([(0, y), (w, y)], fill=(150, 170, 200, 12))
        base = Image.alpha_composite(base, g)

    # Kept deliberately restrained: at full strength the emerald washed the whole
    # right-hand side green and the banner stopped reading as obsidian-with-accent.
    base = Image.alpha_composite(base, radial((w, h), (w * 0.14, h * 0.06), max(w, h) * 0.58, (150, 180, 220), 0.22))
    base = Image.alpha_composite(base, radial((w, h), (w * 0.93, h * 1.04), max(w, h) * 0.50, EMERALD, 0.13))
    base = Image.alpha_composite(base, radial((w, h), (w * 0.50, h * 0.46), max(w, h) * 0.38, (205, 218, 236), 0.09))

    # film grain, the same texture idea the site puts on its surfaces
    noise = Image.effect_noise((w, h), 26).convert("L")
    grain = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    grain.putalpha(noise.point(lambda v: int(abs(v - 128) * 0.16)))
    base = Image.alpha_composite(base, grain)

    # vignette
    vig = Image.new("L", (w, h), 0)
    vd = ImageDraw.Draw(vig)
    for i in range(40):
        t = i / 40
        inset = -int(max(w, h) * 0.25 * (1 - t))
        vd.ellipse([inset, inset, w - inset, h - inset], outline=int(90 * t))
    vig = vig.filter(ImageFilter.GaussianBlur(max(w, h) * 0.06))
    dark = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    dark.putalpha(vig)
    return Image.alpha_composite(base, dark)


def metal_text(text, font, size_hint):
    """Text filled with the site's brushed-metal ramp."""
    tmp = Image.new("L", (10, 10))
    bbox = ImageDraw.Draw(tmp).textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = 8
    mask = Image.new("L", (tw + pad * 2, th + pad * 2), 0)
    ImageDraw.Draw(mask).text((pad - bbox[0], pad - bbox[1]), text, font=font, fill=255)

    grad = Image.new("RGBA", mask.size)
    gd = ImageDraw.Draw(grad)
    stops = [(0.00, (253, 254, 255)), (0.10, (230, 235, 242)), (0.22, (199, 208, 220)),
             (0.34, (243, 246, 250)), (0.48, (180, 190, 204)), (0.62, (141, 152, 167)),
             (0.76, (198, 207, 220)), (0.88, (156, 167, 181)), (1.00, (234, 239, 246))]
    H = mask.size[1]
    for y in range(H):
        t = y / max(1, H - 1)
        for i in range(len(stops) - 1):
            a, b = stops[i], stops[i + 1]
            if a[0] <= t <= b[0]:
                k = (t - a[0]) / max(1e-6, b[0] - a[0])
                c = tuple(int(a[1][j] + (b[1][j] - a[1][j]) * k) for j in range(3))
                gd.line([(0, y), (mask.size[0], y)], fill=c + (255,))
                break
    grad.putalpha(mask)
    return grad


# ---------------------------------------------------------------- PFP 1024
def build_pfp():
    S = 1024
    canvas = backdrop(S, S, grid=False)
    canvas = Image.alpha_composite(canvas, radial((S, S), (S/2, S*0.46), S*0.42, EMERALD, 0.34))

    bot = Image.open(os.path.join(SITE, "logo-transparent.png")).convert("RGBA")
    target = int(S * 0.70)
    bot = bot.resize((target, int(target * bot.height / bot.width)), Image.LANCZOS)

    glow = bot.split()[3].filter(ImageFilter.GaussianBlur(26))
    gl = Image.new("RGBA", bot.size, EMERALD + (0,))
    gl.putalpha(glow.point(lambda v: int(v * 0.42)))
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    pos = ((S - bot.width) // 2, int(S * 0.5 - bot.height / 2))
    layer.alpha_composite(gl, pos)
    layer.alpha_composite(bot, pos)
    canvas = Image.alpha_composite(canvas, layer)

    canvas.convert("RGB").save(os.path.join(OUT, "x-profile.png"), optimize=True)
    print("  x-profile.png       1024x1024")


# ------------------------------------------------------------- BANNER 1500x500
def build_banner():
    W, H = 1500, 500
    canvas = backdrop(W, H)

    # rising emerald horizon along the bottom -- the site's hero chart, echoed
    # Confined to the bottom band. Run any higher and it cuts straight through the
    # tagline, which is what made the first pass look cluttered.
    pts = [(0, 482), (170, 470), (330, 476), (470, 452), (620, 458), (760, 432),
           (900, 440), (1050, 412), (1200, 420), (1350, 392), (1500, 384)]
    line = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(line)
    ld.polygon(pts + [(W, H), (0, H)], fill=EMERALD + (20,))
    ld.line(pts, fill=EMERALD + (150,), width=3, joint="curve")
    line = line.filter(ImageFilter.GaussianBlur(0.6))
    canvas = Image.alpha_composite(canvas, line)

    # centred lockup: robot + wordmark, tagline beneath
    bot = Image.open(os.path.join(SITE, "logo-transparent.png")).convert("RGBA")
    bh = 196
    bot = bot.resize((int(bh * bot.width / bot.height), bh), Image.LANCZOS)

    f_word = ImageFont.truetype(F_DISPLAY, 108)
    word = metal_text("Ponsr", f_word, 108)

    gap = 34
    total = bot.width + gap + word.width
    x0 = (W - total) // 2
    cy = int(H * 0.44)

    glow = bot.split()[3].filter(ImageFilter.GaussianBlur(22))
    gl = Image.new("RGBA", bot.size, EMERALD + (0,))
    gl.putalpha(glow.point(lambda v: int(v * 0.40)))
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    lay.alpha_composite(gl, (x0, cy - bot.height // 2))
    lay.alpha_composite(bot, (x0, cy - bot.height // 2))
    lay.alpha_composite(word, (x0 + bot.width + gap, cy - word.height // 2 - 4))
    canvas = Image.alpha_composite(canvas, lay)

    # tagline, letterspaced mono like the site's eyebrows
    f_tag = ImageFont.truetype(F_MONO, 25)
    tag = "EVERY  LAUNCH,  ON  THE  RECORD."
    td = ImageDraw.Draw(canvas)
    tw = td.textbbox((0, 0), tag, font=f_tag)[2]
    td.text(((W - tw) / 2, cy + 104), tag, font=f_tag, fill=SILVER + (255,))

    f_sub = ImageFont.truetype(F_MONO, 20)
    sub = "tag the bot on X  ->  your token goes live on Robinhood Chain"
    sw = td.textbbox((0, 0), sub, font=f_sub)[2]
    td.text(((W - sw) / 2, cy + 144), sub, font=f_sub, fill=(122, 132, 146, 255))

    canvas.convert("RGB").save(os.path.join(OUT, "x-banner.png"), optimize=True)
    print("  x-banner.png        1500x500")


build_pfp()
build_banner()
for f in ("x-profile.png", "x-banner.png"):
    p = os.path.join(OUT, f)
    print(f"  {f}: {os.path.getsize(p)/1024:.0f} KB")
