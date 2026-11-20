import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConvertResult } from './lib/types';
import { PROFILES } from './lib/types';
import { SourcePanel } from './components/SourcePanel';
import { PlanPanel } from './components/PlanPanel';
import { PdfInspector } from './components/PdfInspector';
import { PixelProbes } from './components/PixelProbes';

export interface ConvertRequest {
  profileId: string;
  strict: boolean;
  rasterScale: number;
}

export function App() {
  const [profileId, setProfileId] = useState('pdf17-native');
  const [strict, setStrict] = useState(false);
  const [rasterScale, setRasterScale] = useState(2);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clickInfo, setClickInfo] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const requestSeq = useRef(0);

  const convert = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, strict, rasterScale }),
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
  }, [profileId, strict, rasterScale]);

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
    a.download = `inkplate-${result.profileId}${result.strict ? '-strict' : ''}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

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
            selectedId={selectedId}
            onSelect={setSelectedId}
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

      {result?.pdfBase64 && <PixelProbes result={result} />}

      <footer className="footnote">
        解析 → 场景 IR → 能力计划 → PDF 写入器 全程本地执行；栅格块用 resvg 独立渲染，PDF 回读用 PDF.js。
      </footer>
    </div>
  );
}
