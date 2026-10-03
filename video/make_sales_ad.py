"""Sales cut (9:16, ~22 s) from an existing product footage file.
Hook -> 3 benefits -> use cases -> fold -> big price + CTA, upbeat music.
Old burned-in captions (lower third) are blurred out and replaced.

Usage: python video/make_sales_ad.py SRC_9x16.mp4 OUT.mp4 [--price 249 --currency сомони --url creo.tj/megamall]
Needs numpy, pillow, ffmpeg (video/setup.sh).
"""
import argparse, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("out")
ap.add_argument("--price", default="249"); ap.add_argument("--currency", default="сомони")
ap.add_argument("--url", default="creo.tj/megamall")
ap.add_argument("--product", default="СУМКА-ПОДСТАВКА 3 в 1")
a = ap.parse_args()
T = tempfile.mkdtemp(); W, H = 1080, 1920
GOLD = (236, 196, 128); WHITE = (255, 255, 255); NAVY = (14, 18, 30)
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"; FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
F = lambda s, b=True: ImageFont.truetype(FB if b else FR, s)

# (src_start, dur, kind, number, tag, headline lines (gold marks with *), sub)
SEG = [
 (0.0, 2.6, "hook", None, "", ["Это не просто сумка.", "*Это рабочее место.*"], "", None),
 (1.5, 3.0, "fn", "1", "ЧЕХОЛ", ["Ноутбук защищён", "*в дороге*"], "Берите с собой без страха", None),
 (6.0, 3.4, "fn", "2", "ПОДСТАВКА", ["Разложили —", "*и можно работать*"], "Удобный угол для печати", None),
 (19.2, 2.6, "fn", "3", "КОВРИК ДЛЯ МЫШИ", ["Рабочая поверхность", "*всегда с вами*"], "Не нужен отдельный коврик", 1.6),
 (12.0, 3.0, "use", None, "ГДЕ УГОДНО", ["Кафе. Офис. Дом.", "*Работайте где удобно*"], "", None),
 (16.2, 2.8, "use", None, "ЗА 3 СЕКУНДЫ", ["Сложили —", "*и пошли дальше*"], "", None),
 (9.0, 4.4, "cta", None, "", [], "", 1.5),
]
total = sum(s[1] for s in SEG)

def tint():
    g = np.zeros((H, W, 4), np.uint8); g[..., :3] = NAVY
    y = np.arange(H)[:, None]
    al = np.clip((y - 1040) / 160, 0, 1) * 0.70 - np.clip((y - 1380) / 120, 0, 1) * 0.30
    g[..., 3] = (al * 255).astype(np.uint8).repeat(W, 1)
    return Image.fromarray(g, "RGBA")

def draw_marked(d, line, y, size, cx=W // 2, x=None):
    """line with *gold* parts; centered if x is None."""
    parts = []; cur = ""; gold = False
    for ch in line.replace("*", "\0"):
        if ch == "\0":
            if cur: parts.append((cur, gold)); cur = ""
            gold = not gold
        else: cur += ch
    if cur: parts.append((cur, gold))
    f = F(size); tot = sum(d.textlength(p, font=f) for p, _ in parts)
    while tot > W - 140 and size > 40:
        size -= 2; f = F(size); tot = sum(d.textlength(p, font=f) for p, _ in parts)
    xx = (W - tot) / 2 if x is None else x
    for p, gd in parts:
        d.text((xx, y), p, font=f, fill=(GOLD if gd else WHITE) + (255,), stroke_width=3, stroke_fill=(0, 0, 0, 120))
        xx += d.textlength(p, font=f)

def overlay(i, s):
    _, dur, kind, num, tag, lines, sub, _sd = s
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if kind == "cta":
        panel = Image.new("RGBA", (W, H - 940), NAVY + (245,)); im.alpha_composite(panel, (0, 940))
    else:
        im.alpha_composite(tint())
    d = ImageDraw.Draw(im)
    if kind == "cta":
        d.text((W // 2 - d.textlength(a.product, font=F(46)) / 2, 1010), a.product, font=F(46), fill=GOLD + (255,))
        pf, cf = F(230), F(60)
        pw = d.textlength(a.price, font=pf); cw = d.textlength(a.currency, font=cf)
        x0 = (W - pw - cw - 24) / 2
        d.text((x0, 1070), a.price, font=pf, fill=WHITE + (255,))
        d.text((x0 + pw + 24, 1215), a.currency, font=cf, fill=GOLD + (255,))
        t3 = "Чехол  •  Подставка  •  Коврик для мыши"
        d.text(((W - d.textlength(t3, font=F(40, False))) / 2, 1370), t3, font=F(40, False), fill=(220, 224, 235, 255))
        d.rounded_rectangle([90, 1470, W - 90, 1620], radius=36, fill=GOLD + (255,))
        bt = "ЗАКАЗАТЬ НА САЙТЕ"; d.text(((W - d.textlength(bt, font=F(60))) / 2, 1507), bt, font=F(60), fill=NAVY + (255,))
        d.text(((W - d.textlength(a.url, font=F(62))) / 2, 1665), a.url, font=F(62), fill=WHITE + (255,))
        t4 = "Megamall.tj"; d.text(((W - d.textlength(t4, font=F(40, False))) / 2, 1790), t4, font=F(40, False), fill=(170, 176, 192, 255))
    else:
        y = 1108
        if num:
            d.ellipse([70, y - 6, 140, y + 64], fill=GOLD + (255,))
            d.text((105 - d.textlength(num, font=F(48)) / 2, y + 2), num, font=F(48), fill=NAVY + (255,))
            d.text((162, y + 8), tag, font=F(42), fill=GOLD + (255,))
        elif tag:
            d.text((70, y + 8), tag, font=F(42), fill=GOLD + (255,))
        ty = y + 76 if (num or tag) else y + 40
        for k, ln in enumerate(lines):
            draw_marked(d, ln, ty + k * 76, 62 if kind == "hook" else 58, x=70)
        if sub: d.text((70, ty + len(lines) * 76 + 8), sub, font=F(36, False), fill=(225, 229, 240, 255))
    p = f"{T}/ov{i}.png"; im.save(p)
    return p

# mask (blur feather)
yy_ = np.arange(H)[:, None]; m = np.clip((yy_ - 1060) / 70, 0, 1) * (1 - np.clip((yy_ - 1370) / 80, 0, 1)); m = (m * 255).astype(np.uint8).repeat(W, 1)
Image.fromarray(m, "L").save(f"{T}/mask.png")

parts = []
for i, s in enumerate(SEG):
    ov = overlay(i, s); out = f"{T}/s{i}.mp4"; dur = s[1]
    if s[7]:
        src_dur = s[7]; ext = f",tpad=stop_mode=clone:stop_duration={dur}"
    else:
        src_dur = dur; ext = ""
    fc = (f"[0:v]fps=30,scale={W}:{H}{ext},trim=duration={dur},setpts=PTS-STARTPTS,split[a][b];"
          f"[b]boxblur=36:4,eq=brightness=-0.12[bl];[2:v]format=gray[m];[bl][m]alphamerge[blm];"
          f"[a][blm]overlay=0:0[c];[1:v]format=rgba,fade=in:st=0.12:d=0.25:alpha=1[o];[c][o]overlay=0:0[v]")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(s[0]), "-t", str(src_dur + 0.05), "-i", a.src,
                    "-loop", "1", "-i", ov, "-loop", "1", "-i", f"{T}/mask.png", "-filter_complex", fc,
                    "-map", "[v]", "-t", str(dur), "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", out], check=True)
    parts.append(out)
open(f"{T}/list.txt", "w").write("".join(f"file '{p}'\n" for p in parts))
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f"{T}/list.txt", "-c", "copy", f"{T}/video.mp4"], check=True)

# ---- music: upbeat 120 BPM, cuts get whoosh, price gets ding ----
sr = 44100; t = np.arange(int(sr * total)) / sr; rng = np.random.default_rng(3)
mf = lambda n: 440 * 2 ** ((n - 69) / 12)
beat = 0.5; mix = np.zeros_like(t)
def put(x, at, snd):
    s0 = int(at * sr); e = min(len(x), s0 + len(snd))
    if s0 < len(x): x[s0:e] += snd[: e - s0]
tk = np.arange(int(0.3 * sr)) / sr
kick = np.sin(2 * np.pi * np.cumsum(50 * np.exp(-tk * 14) + 42) / sr) * np.exp(-tk * 10)
hat = rng.standard_normal(int(0.06 * sr)) * np.exp(-np.arange(int(0.06 * sr)) / sr * 60) * 0.25
clap = rng.standard_normal(int(0.14 * sr)) * np.exp(-np.arange(int(0.14 * sr)) / sr * 28) * 0.45
chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; bass = [33, 29, 36, 31]
for b in range(int(total / beat)):
    at = b * beat; bar = (b // 4) % 4
    if at > 0.0: put(mix, at, kick * 0.9)
    if b % 2 == 1: put(mix, at, hat)
    if b % 4 in (1, 3): put(mix, at, clap)
    put(mix, at + beat / 2, hat * 0.6)
    nb = np.arange(int(0.45 * sr)) / sr
    put(mix, at, np.sin(2 * np.pi * mf(bass[bar]) * nb) * np.exp(-nb * 3) * 0.55)
    for j, n in enumerate(chords[bar]):   # pluck arp on 8ths
        pass
    for h in range(2):
        n = chords[bar][(b * 2 + h) % 3] + 12
        nn = np.arange(int(0.22 * sr)) / sr
        put(mix, at + h * beat / 2, (np.sin(2 * np.pi * mf(n) * nn) + 0.4 * np.sin(4 * np.pi * mf(n) * nn)) * np.exp(-nn * 9) * 0.16)
# whooshes at cuts
cut = 0.0
for s in SEG[:-1]:
    cut += s[1]
    wl = int(0.45 * sr); w = np.convolve(rng.standard_normal(wl), np.ones(30) / 30, "same") * np.linspace(0, 1, wl) ** 2 * 0.5
    put(mix, cut - 0.40, w)
# price ding
cta_at = total - SEG[-1][1] + 0.15
for k, n in enumerate([88, 93]):
    dn = np.arange(int(1.2 * sr)) / sr
    put(mix, cta_at + k * 0.12, np.sin(2 * np.pi * mf(n) * dn) * np.exp(-dn * 3.2) * 0.3)
mix *= np.clip(t / 0.3, 0, 1) * np.clip((total - t) / 1.2, 0, 1)
mix /= np.abs(mix).max() * 1.15
import wave
with wave.open(f"{T}/m.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((mix * 32767).astype("<i2").tobytes())
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{T}/video.mp4", "-i", f"{T}/m.wav", "-af", "loudnorm=I=-14", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", a.out], check=True)
print("done", a.out)
