# 生成 src/boards/render/glyphs.mjs：棋子与坐标字形的 8 位灰度遮罩（构建期一次性生成，运行时不依赖字体或原生模块）。
# 字体：Noto Serif CJK SC Bold（SIL OFL 1.1）、DejaVu Sans / Sans Bold（Bitstream Vera 许可，自由）。
# 用法：python3 scripts/gen-board-glyphs.py <NotoSerifCJK-Bold.ttc> <DejaVuSans.ttf> <DejaVuSans-Bold.ttf>
import base64, json, sys, zlib
from PIL import Image, ImageDraw, ImageFont

cjk_path, dv_path, dvb_path = sys.argv[1:4]
out = {}

def mask(font, ch, box, baseline=False):
    img = Image.new('L', (box * 2, box * 2), 0)
    d = ImageDraw.Draw(img)
    d.text((box, box), ch, font=font, fill=255, anchor='ls' if baseline else 'mm')
    bb = img.getbbox()
    if not bb:
        return None
    img = img.crop(bb)
    w, h = img.size
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    data = co.compress(img.tobytes()) + co.flush()
    g = {'w': w, 'h': h, 'd': base64.b64encode(data).decode('ascii')}
    if baseline:
        g['oy'] = bb[1] - box  # 字形顶到基线的偏移（负数），坐标字符按基线对齐
    return g

cjk = ImageFont.truetype(cjk_path, 40, index=2)  # SC
for ch in '車馬象仕将砲卒兵炮车马相士帅':
    out['x:' + ch] = mask(cjk, ch, 48)
dv = ImageFont.truetype(dv_path, 60)
for ch in '♔♕♖♗♘♙♚♛♜♝♞♟':
    out['c:' + ch] = mask(dv, ch, 64)
dvb = ImageFont.truetype(dvb_path, 18)
for ch in '0123456789ABCDEFGHIJKLMNOPQRSTabcdefgh':
    out['a:' + ch] = mask(dvb, ch, 24, baseline=True)

src = ['/* 自动生成：python3 scripts/gen-board-glyphs.py（见脚本头部的字体与许可）。不要手改。 */',
       'export const GLYPHS = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')), '']
open(sys.argv[4], 'w', encoding='utf-8').write('\n'.join(src))
print(len(out), sum(len(v['d']) for v in out.values()))
