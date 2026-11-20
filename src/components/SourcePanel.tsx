import { useEffect, useRef, useState } from 'react';
import type { ConvertResult } from '../lib/types';
import { DECISION_LABELS, FEATURE_LABELS } from '../lib/types';

interface Props {
  result: ConvertResult;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/** 源 SVG（同源渲染）与对象清单；悬停/点击与转换计划联动。 */
export function SourcePanel({ result, selectedId, onSelect }: Props) {
  const [svg, setSvg] = useState<string>('');
  const [showPlan, setShowPlan] = useState(true);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/poster')
      .then((r) => r.text())
      .then((text) => {
        if (alive) setSvg(text);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const svgEl = el.querySelector('svg');
    if (!svgEl) return;
    svgEl.querySelectorAll('[data-obj]').forEach((g) => {
      g.classList.toggle('is-selected', g.getAttribute('data-obj') === selectedId);
    });
  }, [svg, selectedId, showPlan]);

  return (
    <section className="panel source-panel" data-testid="source-panel">
      <header className="panel-head">
        <h2>源 SVG · 反例海报</h2>
        <button className="link" onClick={() => setShowPlan((v) => !v)}>
          {showPlan ? '隐藏对象轮廓' : '显示对象轮廓'}
        </button>
      </header>
      <p className="panel-sub">
        细藤、偶奇孔、两层裁剪、半透明叶片组与依赖背景的混合块都在这张 440×620 的海报里。
      </p>
      <div
        className={`svg-stage ${showPlan ? 'with-outline' : ''}`}
        ref={holder}
        // 源 SVG 由本地服务器提供，属于应用自身资源
        dangerouslySetInnerHTML={{ __html: stripTitle(svg) }}
      />
      <ul className="object-list" data-testid="object-list">
        {result.entries
          .slice()
          .sort((a, b) => a.depth - b.depth || a.objectId.localeCompare(b.objectId))
          .map((e) => (
            <li key={e.objectId}>
              <button
                className={`object-row ${selectedId === e.objectId ? 'active' : ''}`}
                onClick={() => onSelect(e.objectId)}
                data-testid={`obj-${e.objectId}`}
              >
                <span className={`dot ${decisionClass(e.decision)}`} />
                <span className="obj-name">
                  <b>{e.label}</b>
                  <code>{e.objectId}</code>
                </span>
                <span className="obj-decision">{DECISION_LABELS[e.decision]}</span>
                <span className="obj-features">
                  {e.features.filter((f) => f !== 'path').map((f) => FEATURE_LABELS[f] ?? f).join(' · ') ||
                    '纯路径'}
                </span>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
}

function decisionClass(d: string): string {
  if (d === 'raster') return 'amber';
  if (d === 'reject') return 'red';
  return 'green';
}

function stripTitle(svg: string): string {
  return svg.replace(/<title>[\s\S]*?<\/title>/, '');
}
