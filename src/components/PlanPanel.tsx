import type { Box, ConvertResult, PlanEntry, TileInfo } from '../lib/types';
import { DECISION_LABELS, FEATURE_LABELS } from '../lib/types';

interface Props {
  result: ConvertResult;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  selected: PlanEntry | null;
}

export function PlanPanel({ result, selectedId, onSelect, selected }: Props) {
  const page = result.page;
  const activeTile = result.tiles.find((t) => t.objectId === selectedId) ?? null;

  return (
    <section className="panel plan-panel">
      <header className="panel-head">
        <h2>转换计划</h2>
        <span className={`pill ${result.planStatus}`}>
          {result.planStatus === 'ok' ? '可导出' : '已拒绝'}
        </span>
      </header>
      <p className="panel-sub">
        {result.profileName} · {result.strict ? '严格模式' : '允许局部栅格'}
      </p>

      <div className="stats" data-testid="plan-stats">
        <Stat label="矢量对象" value={result.stats.vector} tone="green" />
        <Stat label="局部栅格" value={result.stats.raster} tone="amber" />
        <Stat label="拒绝" value={result.stats.refused} tone="red" />
      </div>

      <div className="mini-map" aria-label="转换计划缩略图">
        <PlanCanvas result={result} selectedId={selectedId} onSelect={onSelect} />
      </div>

      {result.notes.length > 0 && (
        <ul className="notes">
          {result.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {result.tiles.length > 0 && (
        <div className="tile-box">
          <h3>局部栅格块</h3>
          <p className="hint">
            超出支持范围的一小块才栅格化；依赖背景的块只在这些边界内参与计算，不会重绘整块底色。
          </p>
          {result.tiles.map((t) => (
            <TileRow
              key={t.objectId}
              tile={t}
              active={t.objectId === selectedId}
              onSelect={() => onSelect(t.objectId)}
              pageWidth={page.width}
              pageHeight={page.height}
            />
          ))}
        </div>
      )}

      <div className="entries">
        <h3>逐对象决策</h3>
        {result.entries.map((e) => (
          <button
            key={e.objectId}
            className={`entry ${e.objectId === selectedId ? 'active' : ''}`}
            onClick={() => onSelect(e.objectId)}
            data-testid={`entry-${e.objectId}`}
          >
            <span className={`decision ${e.decision}`}>{DECISION_LABELS[e.decision]}</span>
            <span className="entry-main">
              <b>{e.label}</b>
              <span className="entry-reason">{e.reason}</span>
            </span>
            {e.strategy && <span className="strategy-tag">{e.strategy}</span>}
          </button>
        ))}
      </div>

      {selected && (
        <div className="detail" data-testid="selection-detail">
          <h3>{selected.label}</h3>
          <dl>
            <dt>id</dt>
            <dd>
              <code>{selected.objectId}</code>
            </dd>
            <dt>决策</dt>
            <dd>{DECISION_LABELS[selected.decision]}</dd>
            <dt>特性</dt>
            <dd>{selected.features.map((f) => FEATURE_LABELS[f] ?? f).join('、') || '—'}</dd>
            <dt>边界</dt>
            <dd>
              {fmtBox(selected.bounds)}
              {selected.paintBounds ? ` / 写入 ${fmtBox(selected.paintBounds)}` : ''}
            </dd>
            {selected.readBounds && (
              <>
                <dt>回读</dt>
                <dd>{fmtBox(selected.readBounds)}</dd>
              </>
            )}
          </dl>
          <p className="reason">{selected.reason}</p>
        </div>
      )}

      {activeTile?.strategy === 'backdrop-blend' && (
        <div className="participation" data-testid="participation">
          <h3>背景参与边界</h3>
          <p>{activeTile.note}</p>
          <p className="muted">
            参与元素：{activeTile.backdropIds.join('、') || '无'}
          </p>
          {activeTile.participationBounds && (
            <p className="muted">
              参与范围 {fmtBox(activeTile.participationBounds)}，写入范围 {fmtBox(activeTile.paintBounds)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`stat ${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function TileRow({
  tile,
  active,
  onSelect,
  pageWidth,
  pageHeight,
}: {
  tile: TileInfo;
  active: boolean;
  onSelect: () => void;
  pageWidth: number;
  pageHeight: number;
}) {
  const pct = (b: Box) => ({
    left: `${(b.x / pageWidth) * 100}%`,
    top: `${(b.y / pageHeight) * 100}%`,
    width: `${(b.w / pageWidth) * 100}%`,
    height: `${(b.h / pageHeight) * 100}%`,
  });
  return (
    <button className={`tile-row ${active ? 'active' : ''}`} onClick={onSelect} data-testid={`tile-${tile.objectId}`}>
      <div className="tile-thumb">
        {tile.previewPng ? (
          <img src={tile.previewPng} alt={`${tile.label} 栅格块`} />
        ) : (
          <span className="tile-ph">未生成</span>
        )}
        <div className="tile-map">
          <span className="map-paint" style={pct(tile.paintBounds)} />
          {tile.participationBounds && <span className="map-part" style={pct(tile.participationBounds)} />}
          {tile.readBounds && <span className="map-read" style={pct(tile.readBounds)} />}
        </div>
      </div>
      <div className="tile-meta">
        <b>{tile.label}</b>
        <span>{tile.strategy === 'backdrop-blend' ? '背景依赖混合' : '自身效果（alpha）'}</span>
        <span className="muted" data-testid={`tile-bounds-${tile.objectId}`}>
          写入 {fmtBox(tile.paintBounds)}
          {tile.participationBounds ? ` · 参与 ${fmtBox(tile.participationBounds)}` : ''}
        </span>
        <span className="muted">{tile.note}</span>
      </div>
    </button>
  );
}

function PlanCanvas({
  result,
  selectedId,
  onSelect,
}: {
  result: ConvertResult;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { width, height } = result.page;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="plan-svg">
      <rect x={0} y={0} width={width} height={height} className="plan-bg" />
      {result.entries
        .slice()
        .sort((a, b) => a.depth - b.depth)
        .map((e) => (
          <g key={e.objectId}>
            <rect
              x={e.bounds.x}
              y={e.bounds.y}
              width={Math.max(0.5, e.bounds.w)}
              height={Math.max(0.5, e.bounds.h)}
              className={`plan-box ${e.decision} ${e.objectId === selectedId ? 'active' : ''}`}
              onClick={() => onSelect(e.objectId)}
            >
              <title>{`${e.label} · ${DECISION_LABELS[e.decision]}`}</title>
            </rect>
          </g>
        ))}
      {result.tiles.map((t) => (
        <g key={`tile-${t.objectId}`}>
          <rect
            x={t.paintBounds.x}
            y={t.paintBounds.y}
            width={t.paintBounds.w}
            height={t.paintBounds.h}
            className="plan-tile"
          />
          {t.participationBounds && (
            <rect
              x={t.participationBounds.x}
              y={t.participationBounds.y}
              width={t.participationBounds.w}
              height={t.participationBounds.h}
              className="plan-part"
            />
          )}
        </g>
      ))}
    </svg>
  );
}

function fmtBox(b: Box): string {
  const r = (v: number) => Math.round(v * 10) / 10;
  return `x ${r(b.x)}–${r(b.x + b.w)} / y ${r(b.y)}–${r(b.y + b.h)}`;
}
