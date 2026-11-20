import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConvertResult, ReadbackObject } from '../lib/types';
import { DECISION_LABELS, FEATURE_LABELS } from '../lib/types';
import { openPdf, renderPdfPage, type PdfDocument } from '../lib/pdfClient';
import { readPdfGeometry, hitPdfObjects, type PdfReadResult } from '../lib/pdfReadback';

interface Props {
  result: ConvertResult;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  clickInfo: { x: number; y: number; ids: string[] } | null;
  onPick: (x: number, y: number, ids: string[]) => void;
}

export function PdfInspector({ result, selectedId, onSelect, clickInfo, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [readback, setReadback] = useState<PdfReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [markedOrder, setMarkedOrder] = useState<string[]>([]);
  const [cssWidth, setCssWidth] = useState(440);

  const objectById = useMemo(() => {
    const m = new Map<string, ReadbackObject>();
    for (const o of result.objects) m.set(o.id, o);
    return m;
  }, [result]);

  useEffect(() => {
    let alive = true;
    if (!result.pdfBase64) {
      setDoc(null);
      setReadback(null);
      setMarkedOrder([]);
      return () => {
        alive = false;
      };
    }
    setError(null);
    const bytes = Uint8Array.from(atob(result.pdfBase64), (c) => c.charCodeAt(0));
    openPdf(bytes)
      .then(async (d) => {
        if (!alive) {
          await d.destroy();
          return;
        }
        setDoc(d);
        const page = await d.getPage(1);
        const geom = await readPdfGeometry(page);
        if (!alive) return;
        setReadback(geom);
        setMarkedOrder(geom.order);
      })
      .catch((err) => {
        if (alive) setError(String(err?.message ?? err));
      });
    return () => {
      alive = false;
    };
  }, [result.pdfBase64]);

  useEffect(() => {
    if (!doc) return;
    let alive = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRendering(true);
    doc
      .getPage(1)
      .then((page) => renderPdfPage(page, canvas, cssWidth))
      .catch((err) => setError(String(err?.message ?? err)))
      .finally(() => {
        if (alive) setRendering(false);
      });
    return () => {
      alive = false;
    };
  }, [doc, cssWidth]);

  const onClick = (ev: React.MouseEvent<HTMLDivElement>) => {
    if (!readback) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * result.page.width;
    const y = ((ev.clientY - rect.top) / rect.height) * result.page.height;
    const hits = hitPdfObjects(readback, x, y, result.page.height);
    onPick(Math.round(x * 10) / 10, Math.round(y * 10) / 10, hits.map((h) => h.id));
  };

  const picked = clickInfo ? clickInfo.ids.map((id) => objectById.get(id)).filter(Boolean) as ReadbackObject[] : [];
  const primary = picked[0] ?? null;

  return (
    <section className="panel pdf-panel">
      <header className="panel-head">
        <h2>回读 PDF · 点击检查对象</h2>
        {readback && (
          <span className="pill ok" data-testid="marked-count">
            {readback.order.length} 个标记对象
          </span>
        )}
      </header>
      <p className="panel-sub">
        点击画布任意位置，按 PDF 实际写出的路径/图像与裁剪重建命中对象；右侧显示该处的对象类型与决策。
      </p>

      {error && <div className="inline-error">{error}</div>}

      {!result.pdfBase64 ? (
        <div className="empty-state" data-testid="pdf-empty">
          严格模式已拒绝导出，没有可回读的 PDF。
        </div>
      ) : (
        <div className="pdf-stage-wrap">
          <div
            className="pdf-stage"
            ref={stageRef}
            onClick={onClick}
            style={{ cursor: 'crosshair' }}
            data-testid="pdf-stage"
          >
            <canvas ref={canvasRef} data-testid="pdf-canvas" />
            {rendering && <div className="rendering">渲染中…</div>}
            {clickInfo && (
              <>
                <span
                  className="click-marker"
                  style={{
                    left: `${(clickInfo.x / result.page.width) * 100}%`,
                    top: `${(clickInfo.y / result.page.height) * 100}%`,
                  }}
                />
                {primary && <HoverBox obj={primary} page={result.page} />}
              </>
            )}
            {selectedId && objectById.get(selectedId) && (
              <SelectedOutline obj={objectById.get(selectedId)!} page={result.page} />
            )}
          </div>
          <div className="zoom-controls">
            <label>
              预览宽度
              <input
                type="range"
                min={320}
                max={720}
                step={20}
                value={cssWidth}
                onChange={(e) => setCssWidth(Number(e.target.value))}
              />
            </label>
          </div>
        </div>
      )}

      {clickInfo && (
        <div className="pick-result" data-testid="pick-result">
          <h3>
            点击位置 <code>{clickInfo.x}, {clickInfo.y}</code>
          </h3>
          {picked.length === 0 && <p className="muted">该位置没有可识别的对象（可能是画布底色空隙）。</p>}
          {picked.length > 0 && (
            <ol className="pick-list">
              {picked.map((o, i) => (
                <li key={o.id}>
                  <button
                    className={`pick-row ${i === 0 ? 'primary' : ''}`}
                    onClick={() => onSelect(o.id)}
                    data-testid={`pick-${o.id}`}
                  >
                    <span className={`decision ${o.decision}`}>{DECISION_LABELS[o.decision]}</span>
                    <span className="pick-main">
                      <b>{o.label}</b>
                      <code>{o.id}</code>
                      <span className="pick-features">
                        {o.features.map((f) => FEATURE_LABELS[f] ?? f).join(' · ')}
                      </span>
                    </span>
                  </button>
                  {i === 0 && <PickDetail obj={o} />}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {markedOrder.length > 0 && (
        <details className="order-box" data-testid="marked-order">
          <summary>PDF 中读到的对象顺序（标记内容）</summary>
          <ol>
            {markedOrder.map((id) => (
              <li key={id}>
                <button className="link" onClick={() => onSelect(id)}>
                  {id}
                </button>
                <span className="muted"> · {objectById.get(id)?.label ?? '（未知）'}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function PickDetail({ obj }: { obj: ReadbackObject }) {
  return (
    <div className="pick-detail">
      <p>{obj.reason}</p>
      {obj.tile && (
        <div className="tile-detail">
          <b>{obj.tile.strategy === 'backdrop-blend' ? '背景依赖混合' : '自身效果'}</b>
          <span>写入 {fmtBox(obj.tile.paintBounds)}</span>
          <span>回读 {fmtBox(obj.tile.readBounds)}</span>
          {obj.tile.participationBounds && <span>背景参与 {fmtBox(obj.tile.participationBounds)}</span>}
          <span className="muted">{obj.tile.note}</span>
        </div>
      )}
      {obj.clips.length > 0 && (
        <p className="muted">裁剪：{obj.clips.map((c) => c.label).join(' → ')}</p>
      )}
    </div>
  );
}

function HoverBox({ obj, page }: { obj: ReadbackObject; page: { width: number; height: number } }) {
  const b = obj.tile?.paintBounds ?? obj.bounds;
  return (
    <span
      className="hover-box"
      style={{
        left: `${(b.x / page.width) * 100}%`,
        top: `${(b.y / page.height) * 100}%`,
        width: `${(b.w / page.width) * 100}%`,
        height: `${(b.h / page.height) * 100}%`,
      }}
    />
  );
}

function SelectedOutline({ obj, page }: { obj: ReadbackObject; page: { width: number; height: number } }) {
  const b = obj.tile?.paintBounds ?? obj.bounds;
  return (
    <span
      className="selected-outline"
      style={{
        left: `${(b.x / page.width) * 100}%`,
        top: `${(b.y / page.height) * 100}%`,
        width: `${(b.w / page.width) * 100}%`,
        height: `${(b.h / page.height) * 100}%`,
      }}
    />
  );
}

function fmtBox(b: { x: number; y: number; w: number; h: number }): string {
  const r = (v: number) => Math.round(v * 10) / 10;
  return `x ${r(b.x)}–${r(b.x + b.w)} / y ${r(b.y)}–${r(b.y + b.h)}`;
}
