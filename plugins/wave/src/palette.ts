// 通道调色弹层的纯函数层：HSV/RGB/HEX 颜色换算 + 弹层视口定位几何。
// 全部无 DOM 依赖，可被无头测试直接驱动；fixedPxUnit 是唯一接触 DOM 的例外
// （惰性探测，仅在真实挂载后调用）。

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsv {
  h: number; // 0~360
  s: number; // 0~1
  v: number; // 0~1
}

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** HSV → RGB（h 超范围自动回绕，s/v 越界钳制到 0~1）。 */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60;
  const ss = Math.min(1, Math.max(0, s));
  const vv = Math.min(1, Math.max(0, v));
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = vv - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** RGB → HSV（分量 0~255）。 */
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** RGB → #RRGGBB（大写，分量越界钳制）。 */
export function rgbToHex({ r, g, b }: Rgb): string {
  const to2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}

/** #RRGGBB → RGB；非法输入返回 null（# 可省略）。 */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * 弹层定位：优先锚点上方水平居中，上方放不下翻到下方，上下都放不下钳在视口底部；
 * 水平始终钳在视口内。全部坐标为视觉像素（与 getBoundingClientRect 同基准）。
 * scale 为"fixed 坐标被 zoom 放大"时的视觉尺寸系数（Chromium=根 zoom，WebKitGTK=1）。
 */
export function placePalette(
  anchor: AnchorRect,
  popW: number,
  popH: number,
  vw: number,
  vh: number,
  margin = 8,
  gap = 8,
  scale = 1
): { left: number; top: number; placement: 'above' | 'below' } {
  const w = popW * scale;
  const h = popH * scale;
  const cx = anchor.left + anchor.width / 2;
  const left = Math.max(margin, Math.min(cx - w / 2, vw - margin - w));
  let placement: 'above' | 'below' = 'above';
  let top = anchor.top - gap - h;
  if (top < margin) {
    placement = 'below';
    top = anchor.bottom + gap;
  }
  if (top + h > vh - margin) top = Math.max(margin, vh - margin - h);
  return { left, top, placement };
}

/*
 * 根节点 zoom 等比缩放下的 fixed 浮层坐标换算（与宿主 utils/zoom.ts 同源算法，
 * 插件自包含，此处内联）。Chromium 的 fixed 后代继承 zoom（视觉坐标需除以 zoom），
 * WebKitGTK 不继承（直接用视觉坐标）——运行时放探针实测并缓存。
 */
let zoomAffectsFixed: boolean | null = null;

function detectZoomAffectsFixed(): boolean {
  const html = document.documentElement;
  const prev = html.style.zoom;
  try {
    html.style.zoom = '2';
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:100px;left:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
    const top = probe.getBoundingClientRect().top;
    probe.remove();
    return Math.abs(top - 200) < Math.abs(top - 100);
  } catch {
    return true; // 探测失败时保守沿用 Chromium 行为（历史默认）
  } finally {
    html.style.zoom = prev;
  }
}

/** 视觉像素 → fixed 坐标像素 的除数（内部读取根节点当前 zoom 并完成引擎行为探测）。 */
export function fixedPxUnit(): number {
  const zoom = Number(document.documentElement.style.zoom) || 1;
  if (zoomAffectsFixed === null) zoomAffectsFixed = detectZoomAffectsFixed();
  return zoomAffectsFixed ? zoom : 1;
}
