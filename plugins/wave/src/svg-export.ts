// 波形 SVG 导出器：把环形缓冲中的全部数据生成矢量图（不受当前时间窗限制）。
// 与 Canvas 渲染器同语义：分栏每通道独立量程 / 叠加共用并集量程、
// 按列 min/max 抽稀（输出宽度固定，峰谷不丢）、主题取色。
import type { ThemeColors } from './types';
import type { WaveEngine } from './engine';
import { niceStep, fmtValue, fmtDuration, type YRange } from './renderer';

const WIDTH = 1200;
const AXIS_W = 76;
const PANE_H = 110;
const PAD_L = 12;
const TIME_AXIS_H = 30;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const buildWaveSvg = (
  engine: WaveEngine,
  opts: { overlay: boolean; yRanges: Map<number, YRange | null>; style?: 'line' | 'dots' | 'bars' },
  colors: ThemeColors
): string | null => {
  if (engine.t.count < 2) return null;
  const visIdx = engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false);
  if (visIdx.length === 0) return null;

  const t0 = engine.t.at(0);
  const t1 = engine.lastT;
  const span = Math.max(1, t1 - t0);

  const panes = opts.overlay
    ? [{ channels: visIdx, top: PAD_L, height: PANE_H }]
    : visIdx.map((ch, i) => ({ channels: [ch], top: PAD_L + PANE_H * i, height: PANE_H }));
  const plotLeft = PAD_L;
  const plotRight = WIDTH - AXIS_W;
  const plotW = plotRight - plotLeft;
  const plotBottom = PAD_L + PANE_H * panes.length;
  const height = plotBottom + TIME_AXIS_H + 12;
  const cols = Math.min(1200, Math.max(1, Math.floor(plotW)));

  // 各通道量程：手动优先，否则全量数据自适应（+10% 比例边距）
  const rangeOf = (ch: number): YRange => {
    const manual = opts.yRanges.get(ch);
    if (manual) return manual;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < engine.t.count; i++) {
      const v = engine.channels[ch].at(i);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo) || !isFinite(hi)) return { min: -1, max: 1 };
    if (lo === hi) return { min: lo - 1, max: hi + 1 };
    const pad = (hi - lo) * 0.1;
    return { min: lo - pad, max: hi + pad };
  };

  // 叠加模式：各通道量程取并集
  let paneRange: YRange | null = null;
  if (opts.overlay) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const ch of visIdx) {
      const r = rangeOf(ch);
      lo = Math.min(lo, r.min);
      hi = Math.max(hi, r.max);
    }
    const pad = (hi - lo) * 0.1;
    paneRange = { min: lo - pad, max: hi + pad };
  }

  const parts: string[] = [];
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Consolas, monospace">`
  );
  parts.push(`<rect width="100%" height="100%" fill="${colors.bg}"/>`);
  parts.push(
    `<text x="${PAD_L}" y="16" font-size="13" fill="${colors.text}">NNSerialTool 波形导出 · ${esc(stamp)} · 全量 ${engine.t.count} 帧</text>`
  );

  const yTickLabels: string[] = [];
  for (const pane of panes) {
    const range = opts.overlay && paneRange ? paneRange : rangeOf(pane.channels[0]);
    const yOf = (v: number) => pane.top + pane.height - ((v - range.min) / (range.max - range.min)) * pane.height;

    // 边框 + 通道标注
    parts.push(
      `<rect x="${plotLeft}" y="${pane.top}" width="${plotW}" height="${pane.height}" fill="none" stroke="${colors.border}"/>`
    );
    const label = pane.channels
      .map((ch) => engine.names[ch] ?? `CH${ch + 1}`)
      .join(' / ');
    parts.push(`<text x="${plotLeft + 6}" y="${pane.top + 14}" font-size="12" fill="${colors.text}">${esc(label)}</text>`);

    // Y 轴刻度
    const step = niceStep(range.max - range.min, 4);
    for (let v = Math.ceil(range.min / step) * step; v <= range.max; v += step) {
      const y = pane.top + pane.height - ((v - range.min) / (range.max - range.min)) * pane.height;
      if (y < pane.top + 6 || y > pane.top + pane.height - 2) continue;
      parts.push(
        `<line x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" stroke="${colors.grid}"/>`
      );
      parts.push(`<text x="${plotRight + 6}" y="${y}" font-size="10" fill="${colors.textDim}">${esc(fmtValue(v))}</text>`);
      yTickLabels.push(fmtValue(v));
    }

    // 折线/点/竖条：按视图样式输出（SVG 导出走全量数据，曲线模式抽稀到 ≤4000 点控制文件体积）
    for (const ch of pane.channels) {
      const color = colors.palette[ch % colors.palette.length];
      const yOf = (v: number) => pane.top + pane.height - ((v - range.min) / (range.max - range.min)) * pane.height;
      const style = opts.style ?? 'bars';
      if (style === 'dots') {
        const stride = Math.max(1, Math.ceil(engine.t.count / 8000));
        for (let i = 0; i < engine.t.count; i += stride) {
          const x = (plotLeft + ((engine.t.at(i) - t0) / span) * plotW).toFixed(1);
          const y = yOf(engine.channels[ch].at(i)).toFixed(1);
          parts.push(`<rect x="${+x - 1.5}" y="${+y - 1.5}" width="3" height="3" fill="${color}"/>`);
        }
        continue;
      }
      if (style === 'line') {
        const stride = Math.max(1, Math.ceil(engine.t.count / 4000));
        const segs: string[] = [];
        let started = false;
        for (let i = 0; i < engine.t.count; i += stride) {
          const x = (plotLeft + ((engine.t.at(i) - t0) / span) * plotW).toFixed(1);
          const y = yOf(engine.channels[ch].at(i)).toFixed(1);
          segs.push(`${started ? 'L' : 'M'}${x} ${y}`);
          started = true;
        }
        parts.push(`<path d="${segs.join(' ')}" fill="none" stroke="${color}" stroke-width="1.4"/>`);
        continue;
      }
      const mins = new Float64Array(cols).fill(Infinity);
      const maxs = new Float64Array(cols).fill(-Infinity);
      for (let i = 0; i < engine.t.count; i++) {
        const t = engine.t.at(i);
        const x = ((t - t0) / span) * cols;
        const col = Math.min(cols - 1, Math.max(0, Math.floor(x)));
        const v = engine.channels[ch].at(i);
        if (v < mins[col]) mins[col] = v;
        if (v > maxs[col]) maxs[col] = v;
      }
      const segs: string[] = [];
      let lastCol = -2;
      for (let col = 0; col < cols; col++) {
        if (mins[col] > maxs[col]) continue;
        const x = (plotLeft + col + 0.5).toFixed(1);
        if (col - lastCol > 1 || segs.length === 0) {
          segs.push(`M${x} ${yOf(maxs[col]).toFixed(1)}`);
        }
        segs.push(`L${x} ${yOf(mins[col]).toFixed(1)}`);
        lastCol = col;
      }
      parts.push(`<path d="${segs.join(' ')}" fill="none" stroke="${color}" stroke-width="1.2"/>`);
    }
  }

  // 时间轴刻度
  const tStep = niceStep(span, 10);
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
    const x = plotLeft + ((t - t0) / span) * plotW;
    if (x < plotLeft || x > plotLeft + plotW) continue;
    parts.push(`<text x="${x.toFixed(1)}" y="${plotBottom + 16}" font-size="10" fill="${colors.textDim}" text-anchor="middle">${esc(fmtDuration(t - t0))}</text>`);
  }

  parts.push('</svg>');
  void yTickLabels;
  return parts.join('\n');
};
