#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make-icon.py — 生成日记图标（SVG / PNG / ICO）

    python _tools/make-icon.py

产物：
    assets/icons/diary.svg      矢量源文件（可自行改色改形）
    assets/icons/diary-*.png    16 / 24 / 32 / 48 / 64 / 128 / 256 各尺寸
    assets/icons/diary.ico      多尺寸图标，供 Windows 快捷方式使用

设计：日记本 —— 米色封面 + 琥珀书脊 + 三条笔迹 + 飘带书签。
配色沿用站点的纸 / 墨 / 琥珀三色，无渐变。
"""
import os
import sys
import struct
from PIL import Image, ImageDraw

# Windows 控制台默认 GBK，输出符号会炸；统一成 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "icons")

PAPER  = (232, 229, 225, 255)
COVER  = (247, 245, 241, 255)
INK    = (28, 26, 22, 255)
AMBER  = (166, 125, 72, 255)
RULE   = (176, 170, 158, 255)

S = 512          # 设计基准尺寸
U = S / 32.0     # 1 个"设计单位"


def rect_sharp_bottom(d, box, fill, rad):
    """上面两角圆、下面两角方 —— PIL 的 rounded_rectangle 做不到，手工拼。"""
    x0, y0, x1, y1 = box
    d.rounded_rectangle((x0, y0, x1, y0 + rad * 2), radius=rad, fill=fill)
    d.rectangle((x0, y0 + rad, x1, y1), fill=fill)


def render_svg(two_tone: bool, ribbon: bool) -> str:
    cover = "#f5f3ef" if two_tone else "#e8e5e1"
    cover_edge = "#d9d4cb" if two_tone else "#cfc9bf"
    parts = [
        f'<rect x="3" y="1.6" width="23" height="29.2" rx="2.6" fill="{cover}"/>',
        f'<rect x="3.9" y="2.5" width="21.2" height="27.4" rx="2.2" fill="none" stroke="{cover_edge}" stroke-width="0.5"/>',
        f'<rect x="3" y="1.6" width="6.4" height="29.2" rx="2.6" fill="#a67d48"/>',
        '<rect x="10.4" y="9" width="12" height="1.5" fill="#b0aa9e"/>',
        '<rect x="10.4" y="14.2" width="12" height="1.5" fill="#b0aa9e"/>',
        '<rect x="10.4" y="19.4" width="7.4" height="1.5" fill="#b0aa9e"/>',
    ]
    if ribbon:
        parts.append('<rect x="20.4" y="1.6" width="4.2" height="10.6" fill="#1c1a16"/>')
        parts.append('<path d="M20.4 12.2 L22.5 9.6 L24.6 12.2 Z" fill="#a67d48"/>')
    body = "\n    ".join(parts)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="512" height="512">\n'
        '  <!-- 日记本：纸 / 墨 / 琥珀三色，无渐变 -->\n'
        f'  <g>\n    {body}\n  </g>\n'
        '</svg>\n'
    )


def render_png(size: int, two_tone: bool = True, ribbon: bool = True) -> Image.Image:
    """按设计单位直接绘制，尺寸小时可关掉飘带避免糊成一团。"""
    k = size / 32.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def sc(v):
        return v * k

    # 封面
    body = (sc(3), sc(1.6), sc(26), sc(30.8))
    rect_sharp_bottom(d, body, COVER if two_tone else PAPER, max(1, int(sc(2.6))))
    # 内描边
    if size >= 32:
        d.rounded_rectangle((sc(3.9), sc(2.5), sc(25.1), sc(29.9)),
                            radius=max(1, int(sc(2.2))),
                            outline=(217, 212, 203, 255) if two_tone else (207, 201, 191, 255),
                            width=max(1, int(sc(0.45))))
    # 书脊
    rect_sharp_bottom(d, (sc(3), sc(1.6), sc(9.4), sc(30.8)), AMBER, max(1, int(sc(2.6))))
    # 笔迹线
    lw = max(1, int(sc(1.5)))
    for i, w in enumerate((12, 12, 7.4)):
        y = sc(9 + i * 5.2)
        d.rectangle((sc(10.4), y, sc(10.4 + w), y + lw), fill=RULE)
    # 飘带书签（小尺寸下太细，省略）
    if ribbon and size >= 24:
        d.rectangle((sc(20.4), sc(1.6), sc(24.6), sc(12.2)), fill=INK)
        d.polygon([(sc(20.4), sc(12.2)), (sc(22.5), sc(9.6)), (sc(24.6), sc(12.2))], fill=AMBER)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)

    with open(os.path.join(OUT, "diary.svg"), "w", encoding="utf-8") as f:
        f.write(render_svg(two_tone=True, ribbon=True))
    print("✓ diary.svg")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = []
    for s in sizes:
        im = render_png(s)
        im.save(os.path.join(OUT, f"diary-{s}.png"))
        frames.append(im)
    print("✓ PNG:", ", ".join(f"{s}px" for s in sizes))

    ico = os.path.join(OUT, "diary.ico")
    # 用最大帧作为基底，其余作为附加尺寸写入
    frames[-1].save(ico, format="ICO", sizes=[(s, s) for s in sizes])
    print("✓ diary.ico  (%d 个尺寸, %d 字节)" % (len(sizes), os.path.getsize(ico)))

    # 校验 ICO 里真的含多个尺寸
    with open(ico, "rb") as f:
        head = f.read(6)
    _, kind, count = struct.unpack("<HHH", head)
    print("  ICO 目录项:", count, "(type=%d)" % kind)


if __name__ == "__main__":
    main()
