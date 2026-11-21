import { useEffect, useRef, useState } from 'react';
import type { ConvertResult, ProbePoint } from '../lib/types';
import { PROBE_SETS, resolveProbe } from '../lib/types';
import { openPdf, renderPdfPage, sampleAt, compareColors, hex, regionDiff } from '../lib/pdfClient';
import type { PatternOverrides } from '../App';

interface Props {
  result: ConvertResult;
  svg: string;
  patternOverrides: PatternOverrides;
}

interface ProbeRow extends ProbePoint {
  px: number;
  py: number;
  pdf: [number, number, number] | null;
  source: [number, number, number] | null;
  expectDelta: number | null;
  delta: number | null;
  pass: boolean | null;
  region?: { meanAbs: number; over4: number; pixels: number; maxDelta: number };
}

const ART_NOTES: Record<string, { sub: string; check: string }> = {
  poster: {
    sub: '源图由 resvg 独立渲染，PDF 由 PDF.js 回读渲染，两者在设计坐标的同一像素上取样。覆盖孔内、组重叠、细线接合、依赖背景的混合与模糊块。',
    check:
      '角标十字在设计坐标 (24, 22) 与 (24, 588) 两端对称；PDF 内容先整体 1 0 0 -1 0 620 cm 翻转，如果翻转遗漏或重复，探针对应位置的像素会明显偏移。细藤的 miter 接合在放大视图里与源图逐像素相近，说明接合方式与坐标变换同时正确。',
  },
  duo: {
    sub: '双实例画板：色标位置、图案周期、透明交叠与镜像/半尺寸实例的图案相位逐点对照。画布原点在负坐标区，探针坐标均为设计坐标。',
    check:
      '织纹长条上 period-a 与 period-b 相隔恰好一个 XStep（80 单位），读数一致即证明重复单元起算点与周期正确；实例 B 缩小一半后恰好被一个单元盖满；零宽参考线按规范不渲染 objectBoundingBox 渐变，只剩描边。',
  },
};

export function PixelProbes({ result, svg, patternOverrides }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const probes = PROBE_SETS[result.art] ?? PROBE_SETS.poster;
  const notes = ART_NOTES[result.art] ?? ART_NOTES.poster;
  const [rows, setRows] = useState<ProbeRow[]>([]);
  const [srcUrl, setSrcUrl] = useState<string>('');
  const [imgOk, setImgOk] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!result.pdfBase64) {
      setBusy(false);
      return;
    }
    setBusy(true);
    let objectUrl = '';
    (async () => {
      // 源图必须渲染「当前编辑后的 SVG + 仅实例覆盖」，与引擎输入保持一致
      const res = await fetch('/api/source.png', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          svg,
          art: result.art,
          width: result.page.width * 2,
          patternOverrides: Object.keys(patternOverrides).length ? patternOverrides : undefined,
        }),
      });
      if (!res.ok) throw new Error('源图渲染失败');
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      const src = new Image();
      src.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        src.onload = () => resolve();
        src.onerror = () => reject(new Error('源图加载失败'));
      });
      if (!alive) return;
      setSrcUrl(objectUrl);
      setImgOk(true);

      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = src.naturalWidth;
      srcCanvas.height = src.naturalHeight;
      srcCanvas.getContext('2d', { willReadFrequently: true })!.drawImage(src, 0, 0);

      const bytes = Uint8Array.from(atob(result.pdfBase64!), (c) => c.charCodeAt(0));
      const doc = await openPdf(bytes);
      const page = await doc.getPage(1);
      const canvas = canvasRef.current;
      if (!canvas || !alive) return;
      // 画布要填满自己的网格单元，不能使用固定的设计宽
      const cssWidth = Math.max(160, Math.round(canvas.parentElement?.clientWidth ?? result.page.width));
      await renderPdfPage(page, canvas, cssWidth, 2);
      await doc.destroy();
      if (!alive) return;

      const next: ProbeRow[] = [];
      for (const p of probes) {
        const pos = resolveProbe(p, result.entries);
        if (!pos) continue;
        const pdf = sampleAt(canvas, result.page.width, { x: pos.x, y: pos.y, radius: p.radius });
        const source = sampleAt(srcCanvas, result.page.width, { x: pos.x, y: pos.y, radius: p.radius });
        const expect = p.expect ?? source;
        const vsSource = compareColors(pdf, source);
        const vsExpect = compareColors(pdf, expect);
        // 以「与源图同点取样」为准；容差沿用探针配置
        const pass = vsSource.meanDelta <= (p.tolerance ?? 6);
        const box = {
          x: pos.x - (p.radius ?? 3) * 2,
          y: pos.y - (p.radius ?? 3) * 2,
          w: (p.radius ?? 3) * 4,
          h: (p.radius ?? 3) * 4,
        };
        const region = regionDiff(canvas, src, box, result.page.width);
        next.push({
          ...p,
          px: Math.round(pos.x * 10) / 10,
          py: Math.round(pos.y * 10) / 10,
          pdf,
          source,
          delta: vsSource.meanDelta,
          expectDelta: vsExpect.meanDelta,
          pass,
          region,
        });
      }
      if (alive) {
        setRows(next);
        setBusy(false);
      }
    })().catch(() => {
      if (alive) setBusy(false);
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [result, svg, patternOverrides, probes]);

  const passing = rows.filter((r) => r.pass === true).length;
  const measured = rows.filter((r) => r.pass !== null).length;

  return (
    <section className="panel probes-panel" data-testid="pixel-probes">
      <header className="panel-head">
        <h2>独立渲染对照 · 像素校验</h2>
        {measured > 0 && (
          <span className={`pill ${passing === measured ? 'ok' : 'warn'}`} data-testid="probe-summary">
            {passing}/{measured} 通过
          </span>
        )}
      </header>
      <p className="panel-sub">{notes.sub}</p>

      <div className="probe-body">
        <div className="probe-canvases">
          <figure>
            <figcaption>源 SVG（resvg）</figcaption>
            {srcUrl && <img src={srcUrl} alt="源 SVG 独立渲染" data-testid="source-render" />}
          </figure>
          <figure>
            <figcaption>回读 PDF（PDF.js）</figcaption>
            <canvas ref={canvasRef} data-testid="pdf-probe-canvas" />
          </figure>
        </div>

        <table className="probe-table">
          <thead>
            <tr>
              <th>探针</th>
              <th>坐标</th>
              <th>源图实测</th>
              <th>PDF 实测</th>
              <th>Δ</th>
              <th>区域均差</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid={`probe-${r.id}`}>
                <td>
                  <b>{r.label}</b>
                  <div className="probe-note">{r.note}</div>
                </td>
                <td className="mono">
                  {r.px}, {r.py}
                </td>
                <td>{r.source ? <Swatch rgb={r.source} /> : '—'}</td>
                <td>{r.pdf ? <Swatch rgb={r.pdf} /> : '—'}</td>
                <td className="mono">{r.delta == null ? '—' : r.delta}</td>
                <td className="mono">
                  {r.region ? (
                    <span title={`${r.region.over4} / ${r.region.pixels} 像素超过 4 级差；最大 ${r.region.maxDelta}`}>
                      {r.region.meanAbs}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {r.pass == null ? (
                    '…'
                  ) : r.pass ? (
                    <span className="badge pass">通过</span>
                  ) : (
                    <span className="badge fail">偏差</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {busy && <div className="muted">正在渲染并比对…</div>}
      {!imgOk && !busy && <div className="inline-error">无法加载源图。</div>}

      <div className="flip-check">
        <h3>坐标与周期检查</h3>
        <p>{notes.check}</p>
      </div>
    </section>
  );
}

function Swatch({ rgb }: { rgb: [number, number, number] }) {
  return (
    <span className="swatch">
      <span className="chip" style={{ background: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})` }} />
      <code>{hex(rgb)}</code>
    </span>
  );
}
