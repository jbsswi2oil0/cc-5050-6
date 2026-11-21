import { useEffect, useRef, useState } from 'react';
import type { ConvertResult } from '../lib/types';
import { DECISION_LABELS, FEATURE_LABELS } from '../lib/types';

interface Props {
  result: ConvertResult;
  svg: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 预览里拖动共享实例（设计单位平移量）。 */
  onDragInstance: (id: string, dx: number, dy: number) => void;
}

const ART_META: Record<string, { title: string; sub: string }> = {
  poster: {
    title: '源 SVG · 反例海报',
    sub: '细藤、偶奇孔、两层裁剪、半透明叶片组与依赖背景的混合块都在这张 440×620 的海报里。',
  },
  duo: {
    title: '源 SVG · 双实例（可直接拖动实例）',
    sub: '两个 <use> 实例共享同一条宝石路径：A 镜像、B 半尺寸。拖动任一实例会把平移写回源 SVG 并自动重转，画布原点在负坐标区。',
  },
};

/** 源 SVG（同源渲染）与对象清单；悬停/点击与转换计划联动，<use> 实例可拖动。 */
export function SourcePanel({ result, svg, selectedId, onSelect, onDragInstance }: Props) {
  const [showPlan, setShowPlan] = useState(true);
  const holder = useRef<HTMLDivElement>(null);
  const meta = ART_META[result.art] ?? ART_META.poster;

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const svgEl = el.querySelector('svg');
    if (!svgEl) return;
    svgEl.querySelectorAll('[data-obj]').forEach((g) => {
      g.classList.toggle('is-selected', g.getAttribute('data-obj') === selectedId);
    });
  }, [svg, selectedId, showPlan]);

  // 给 <use data-obj> 挂指针拖动：位移换算成设计单位后回写源 SVG
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const svgEl = el.querySelector('svg');
    if (!svgEl) return;
    const targets = Array.from(svgEl.querySelectorAll('use[data-obj]')) as SVGUseElement[];
    if (!targets.length) return;

    const cleanups: Array<() => void> = [];
    for (const target of targets) {
      const id = target.getAttribute('data-obj')!;
      target.classList.add('is-draggable');

      const onDown = (ev: PointerEvent) => {
        ev.preventDefault();
        const startX = ev.clientX;
        const startY = ev.clientY;
        let last = { dx: 0, dy: 0 };
        target.classList.add('is-dragging');

        const toDesign = (px: number, py: number): { dx: number; dy: number } => {
          const ctm = svgEl.getScreenCTM();
          if (!ctm) return { dx: 0, dy: 0 };
          return { dx: px / ctm.a, dy: py / ctm.d };
        };
        const onMove = (me: PointerEvent) => {
          last = { dx: me.clientX - startX, dy: me.clientY - startY };
          target.style.transform = `translate(${last.dx}px, ${last.dy}px)`;
        };
        const onUp = (ue: PointerEvent) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          target.classList.remove('is-dragging');
          target.style.transform = '';
          const d = toDesign(ue.clientX - startX, ue.clientY - startY);
          const dx = Math.round(d.dx * 100) / 100;
          const dy = Math.round(d.dy * 100) / 100;
          if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) onDragInstance(id, dx, dy);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      };

      target.addEventListener('pointerdown', onDown);
      cleanups.push(() => target.removeEventListener('pointerdown', onDown));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [svg, onDragInstance]);

  return (
    <section className="panel source-panel" data-testid="source-panel">
      <header className="panel-head">
        <h2>{meta.title}</h2>
        <button className="link" onClick={() => setShowPlan((v) => !v)}>
          {showPlan ? '隐藏对象轮廓' : '显示对象轮廓'}
        </button>
      </header>
      <p className="panel-sub">{meta.sub}</p>
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
