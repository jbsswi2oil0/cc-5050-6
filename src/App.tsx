import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConvertResult } from './lib/types';
import { PROFILES } from './lib/types';
import { applyPatternOrigin, applyUseDrag } from './lib/svgEdits';
import { SourcePanel } from './components/SourcePanel';
import { PlanPanel } from './components/PlanPanel';
import { PdfInspector } from './components/PdfInspector';
import { PixelProbes } from './components/PixelProbes';
import { ResourcePanel } from './components/ResourcePanel';

export const ARTWORK_TABS = [
  { id: 'poster', name: '反例海报', desc: '细藤、偶奇孔、裁剪、混合与模糊' },
  { id: 'duo', name: '双实例', desc: '共享路径 · 镜像与半尺寸实例 · 平铺图案' },
] as const;

export type PatternOverrides = Record<string, { dx: number; dy: number }>;

/** 在浏览器里解析 → 修改 → 序列化画板文本。 */
function editSvg(svgText: string, edit: (doc: Document) => void): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  edit(doc);
  return new XMLSerializer().serializeToString(doc);
}

export function App() {
  const [profileId, setProfileId] = useState('pdf17-native');
  const [strict, setStrict] = useState(false);
  const [rasterScale, setRasterScale] = useState(2);
  const [art, setArt] = useState<string>('poster');
  const [svgText, setSvgText] = useState<string>('');
  const [patternOverrides, setPatternOverrides] = useState<PatternOverrides>({});
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clickInfo, setClickInfo] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const requestSeq = useRef(0);

  // 切换画板：取源 SVG、清空覆盖与结果
  useEffect(() => {
    let alive = true;
    fetch(`/api/poster?art=${art}`)
      .then((r) => r.text())
      .then((text) => {
        if (!alive) return;
        setSvgText(text);
        setPatternOverrides({});
        setResult(null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [art]);

  const convert = useCallback(async () => {
    if (!svgText) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId,
          strict,
          rasterScale,
          svg: svgText,
          art,
          patternOverrides: Object.keys(patternOverrides).length ? patternOverrides : undefined,
        }),
      });
      const data = (await res.json()) as ConvertResult & { error?: string };
      if (seq !== requestSeq.current) return;
      if (data.error) throw new Error(data.error);
      setResult(data);
      setSelectedId(null);
      setClickInfo(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(String((err as Error).message ?? err));
      setResult(null);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [profileId, strict, rasterScale, svgText, art, patternOverrides]);

  useEffect(() => {
    void convert();
  }, [convert]);

  const download = useCallback(() => {
    if (!result?.pdfBase64) return;
    const bytes = Uint8Array.from(atob(result.pdfBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inkplate-${result.art}-${result.profileId}${result.strict ? '-strict' : ''}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  /** 预览里拖动实例：平移量写回源 SVG 的 <use> 变换，随后自动重转。 */
  const dragInstance = useCallback((id: string, dx: number, dy: number) => {
    setSvgText((cur) => editSvg(cur, (doc) => applyUseDrag(doc as never, { [id]: { dx, dy } })));
  }, []);

  /** 图案原点 · 更改公共定义：所有引用实例一起移动。 */
  const patternOriginShared = useCallback((patternId: string, x: number, y: number) => {
    setSvgText((cur) => editSvg(cur, (doc) => applyPatternOrigin(doc as never, patternId, x, y)));
  }, []);

  /** 图案原点 · 仅覆盖某一实例：引擎在使用点的 Pattern /Matrix 里平移。 */
  const patternOriginInstance = useCallback((nodeId: string, dx: number, dy: number) => {
    setPatternOverrides((cur) => {
      const next = { ...cur };
      if (dx === 0 && dy === 0) delete next[nodeId];
      else next[nodeId] = { dx, dy };
      return next;
    });
  }, []);

  const selected = useMemo(
    () => result?.entries.find((e) => e.objectId === selectedId) ?? null,
    [result, selectedId],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◑</span>
          <div>
            <h1>Inkplate · SVG → PDF 转换窗口</h1>
            <p>按目标能力决定转换计划 · 回读 PDF 检查对象 · 像素级对照验收</p>
          </div>
        </div>
        <div className="topbar-actions">
          {result?.pdfBase64 && (
            <button className="btn primary" onClick={download} data-testid="download-pdf">
              导出 PDF
            </button>
          )}
          <button className="btn" onClick={() => void convert()} disabled={loading} data-testid="reconvert">
            {loading ? '转换中…' : '重新转换'}
          </button>
        </div>
      </header>

      <section className="controls">
        <div className="control-group">
          <label className="control-label">画板</label>
          <div className="segmented" role="radiogroup" aria-label="画板">
            {ARTWORK_TABS.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={art === t.id}
                className={`segment ${art === t.id ? 'active' : ''}`}
                onClick={() => setArt(t.id)}
                data-testid={`art-${t.id}`}
              >
                {t.name}
              </button>
            ))}
          </div>
          <p className="control-help">{ARTWORK_TABS.find((t) => t.id === art)?.desc}</p>
        </div>

        <div className="control-group">
          <label className="control-label">目标能力档案</label>
          <div className="segmented" role="radiogroup" aria-label="目标能力档案">
            {PROFILES.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={profileId === p.id}
                className={`segment ${profileId === p.id ? 'active' : ''}`}
                onClick={() => setProfileId(p.id)}
                data-testid={`profile-${p.id}`}
              >
                {p.name}
              </button>
            ))}
          </div>
          <p className="control-help">{PROFILES.find((p) => p.id === profileId)?.description}</p>
        </div>

        <div className="control-group narrow">
          <label className="control-label" htmlFor="strict-toggle">
            严格模式
          </label>
          <button
            id="strict-toggle"
            role="switch"
            aria-checked={strict}
            className={`switch ${strict ? 'on' : ''}`}
            onClick={() => setStrict((v) => !v)}
            data-testid="strict-toggle"
          >
            <span className="knob" />
            <span>{strict ? '开 · 超出能力即拒绝' : '关 · 允许局部栅格化'}</span>
          </button>
          <p className="control-help">
            严格模式不会偷偷把对象降级成位图，而是明确拒绝并中止导出。
          </p>
        </div>

        <div className="control-group narrow">
          <label className="control-label" htmlFor="scale-range">
            局部栅格密度 {rasterScale}×
          </label>
          <input
            id="scale-range"
            type="range"
            min={1}
            max={4}
            step={0.5}
            value={rasterScale}
            onChange={(e) => setRasterScale(Number(e.target.value))}
            data-testid="raster-scale"
          />
          <p className="control-help">只影响需要栅格化的小块，其余对象保持矢量。</p>
        </div>
      </section>

      {error && <div className="banner error">转换出错：{error}</div>}

      {result && result.planStatus === 'refused' && (
        <div className="banner refused" data-testid="strict-refusal">
          <strong>严格模式已拒绝导出</strong>
          <span>
            {result.refusals.length} 个对象无法用当前档案的矢量能力表达，转换中止。没有生成任何降级 PDF。
          </span>
          <ul>
            {result.refusals.map((r) => (
              <li key={r.objectId}>
                <b>{r.label}</b>（{r.objectId}）：{r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && (
        <main className="workspace">
          <SourcePanel
            result={result}
            svg={svgText}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDragInstance={dragInstance}
          />
          <PlanPanel
            result={result}
            selectedId={selectedId}
            onSelect={setSelectedId}
            selected={selected}
          />
          <PdfInspector
            result={result}
            selectedId={selectedId}
            onSelect={setSelectedId}
            clickInfo={clickInfo}
            onPick={(x, y, ids) => {
              setClickInfo({ x, y, ids });
              setSelectedId(ids[0] ?? null);
            }}
          />
        </main>
      )}

      {result?.resources && (
        <ResourcePanel
          result={result}
          overrides={patternOverrides}
          onSharedOrigin={patternOriginShared}
          onInstanceOrigin={patternOriginInstance}
        />
      )}

      {result?.pdfBase64 && (
        <PixelProbes result={result} svg={svgText} patternOverrides={patternOverrides} />
      )}

      <footer className="footnote">
        解析 → 场景 IR → 能力计划 → PDF 写入器 全程本地执行；栅格块用 resvg 独立渲染，PDF 回读用 PDF.js。
      </footer>
    </div>
  );
}
