import { useState } from 'react';
import type { ConvertResult, ResourceTable } from '../lib/types';
import type { PatternOverrides } from '../App';

interface Props {
  result: ConvertResult;
  overrides: PatternOverrides;
  /** 更改公共定义：所有引用该图案的实例一起移动。 */
  onSharedOrigin: (patternId: string, x: number, y: number) => void;
  /** 仅覆盖某一实例：引擎在使用点的 Pattern /Matrix 里平移。 */
  onInstanceOrigin: (nodeId: string, dx: number, dy: number) => void;
}

const fmt = (v: number) => Math.round(v * 100) / 100;
const fmtList = (xs: readonly number[]) => `[${xs.map(fmt).join(' ')}]`;

/** 跨实例共享资源表：Shading / Pattern / Form 三级资源与每个使用点的归属。 */
export function ResourcePanel({ result, overrides, onSharedOrigin, onInstanceOrigin }: Props) {
  const res = result.resources!;
  const patternIds = [...new Set(res.tilingPatterns.map((t) => t.patternId))];

  return (
    <section className="panel resource-panel" data-testid="resource-panel">
      <header className="panel-head">
        <h2>共享资源表 · 跨实例复用</h2>
        <span className="pill ok" data-testid="resource-counts">
          Shading {res.shadings.length} · 渐变图案 {res.shadingPatterns.length} · 平铺 {res.tilingPatterns.length} ·
          Form {res.forms.length}
        </span>
      </header>
      <p className="panel-sub">
        两个实例共用同一条路径与同一份图案单元：实例的镜像/缩放只留在使用点的 cm 里，资源本体全文档唯一。
      </p>

      {result.warnings.length > 0 && (
        <div className="diag-box" data-testid="diagnostics">
          <h3>诊断</h3>
          <ul>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="res-grid">
        <div className="res-block">
          <h3>变换归属（哪些写进资源，哪些留在使用点）</h3>
          <ul className="split-notes" data-testid="transform-split">
            {res.transformSplit.map((note, i) => {
              const sep = note.indexOf('：');
              return (
                <li key={i}>
                  <b>{note.slice(0, sep)}</b>
                  <span>{note.slice(sep + 1)}</span>
                </li>
              );
            })}
          </ul>

          <h3>Shading（渐变色标 · 全文档唯一）</h3>
          <table className="res-table" data-testid="shading-table">
            <thead>
              <tr>
                <th>资源</th>
                <th>来源渐变</th>
                <th>定义空间向量</th>
                <th>色标</th>
              </tr>
            </thead>
            <tbody>
              {res.shadings.map((s) => (
                <tr key={s.name}>
                  <td className="mono">{s.name}</td>
                  <td className="mono">{s.gradientId ?? '—'}</td>
                  <td className="mono">{fmtList(s.coords)}</td>
                  <td>
                    <span className="stops">
                      {s.stops.map((st, i) => (
                        <span key={i} className="stop" title={`offset ${st.offset}`}>
                          <span className="chip" style={{ background: st.color }} />
                          {st.offset}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>渐变图案（Shading Pattern · 各使用点的坐标映射）</h3>
          <table className="res-table">
            <thead>
              <tr>
                <th>资源</th>
                <th>→ Shading</th>
                <th>/Matrix</th>
                <th>使用点</th>
              </tr>
            </thead>
            <tbody>
              {res.shadingPatterns.map((p) => (
                <tr key={p.name}>
                  <td className="mono">{p.name}</td>
                  <td className="mono">{p.shading}</td>
                  <td className="mono">{fmtList(p.matrix)}</td>
                  <td className="mono">{p.usedBy.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="res-block">
          <h3>平铺图案（共享单元 · 覆盖才派生）</h3>
          <table className="res-table" data-testid="tiling-table">
            <thead>
              <tr>
                <th>资源</th>
                <th>图案</th>
                <th>周期 XStep/YStep</th>
                <th>/Matrix</th>
                <th>单元 Form</th>
                <th>使用点</th>
              </tr>
            </thead>
            <tbody>
              {res.tilingPatterns.map((t) => (
                <tr key={t.name}>
                  <td className="mono">
                    {t.name}
                    {t.override && (
                      <span className="ovr-chip" title="单实例原点覆盖派生的字典">
                        覆盖 {t.override.dx},{t.override.dy}
                      </span>
                    )}
                  </td>
                  <td className="mono">{t.patternId}</td>
                  <td className="mono">{fmtList(t.step)}</td>
                  <td className="mono">{fmtList(t.matrix)}</td>
                  <td className="mono">{t.cellForm}</td>
                  <td className="mono">{t.usedBy.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Form XObject（共享路径几何与图案单元）</h3>
          <table className="res-table" data-testid="form-table">
            <thead>
              <tr>
                <th>资源</th>
                <th>类型</th>
                <th>来源</th>
                <th>使用点</th>
              </tr>
            </thead>
            <tbody>
              {res.forms.map((f) => (
                <tr key={f.name}>
                  <td className="mono">{f.name}</td>
                  <td>{f.kind === 'shared-path' ? '共享路径' : '图案单元'}</td>
                  <td className="mono">{f.sourceId}</td>
                  <td className="mono">{f.usedBy.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>使用点 · 重复单元从何处起算</h3>
          <table className="res-table" data-testid="usage-table">
            <thead>
              <tr>
                <th>对象</th>
                <th>填充</th>
                <th>资源</th>
                <th>路径 Form</th>
                <th>单元起点（设计坐标）</th>
                <th>周期（设计坐标）</th>
              </tr>
            </thead>
            <tbody>
              {res.usage.map((u) => (
                <tr key={u.object}>
                  <td className="mono">{u.object}</td>
                  <td>{fillLabel(u.fillKind)}</td>
                  <td className="mono">{u.resource ?? '—'}</td>
                  <td className="mono">{u.pathForm ?? '—'}</td>
                  <td className="mono">{u.tileOriginDesign ? fmtList(u.tileOriginDesign) : '—'}</td>
                  <td className="mono">{u.periodDesign ? fmtList(u.periodDesign) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {patternIds.length > 0 && (
        <div className="origin-editor" data-testid="origin-editor">
          <h3>编辑图案原点</h3>
          <p className="hint">
            「更改公共定义」移动所有引用实例的重复单元；「仅覆盖某一实例」只为该实例派生一份新平铺字典，共享单元与其余实例不变。
          </p>
          {patternIds.map((pid) => (
            <PatternOriginEditor
              key={`${pid}:${seedOf(res, pid).join(',')}`}
              res={res}
              patternId={pid}
              overrides={overrides}
              onSharedOrigin={onSharedOrigin}
              onInstanceOrigin={onInstanceOrigin}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function fillLabel(kind: string): string {
  if (kind === 'gradient') return '渐变';
  if (kind === 'pattern') return '图案';
  if (kind === 'solid') return '纯色';
  return '无';
}

/** 公共定义的当前原点：取该图案非覆盖、纯平移（Form 内局部映射）字典的 /Matrix 平移量。 */
function seedOf(res: ResourceTable, patternId: string): [number, number] {
  const t = res.tilingPatterns.find(
    (p) =>
      p.patternId === patternId &&
      !p.override &&
      Math.abs(p.matrix[0] - 1) < 1e-6 &&
      Math.abs(p.matrix[1]) < 1e-6 &&
      Math.abs(p.matrix[2]) < 1e-6 &&
      Math.abs(p.matrix[3] - 1) < 1e-6,
  );
  return t ? [fmt(t.matrix[4]), fmt(t.matrix[5])] : [0, 0];
}

function PatternOriginEditor({
  res,
  patternId,
  overrides,
  onSharedOrigin,
  onInstanceOrigin,
}: {
  res: ResourceTable;
  patternId: string;
  overrides: PatternOverrides;
  onSharedOrigin: Props['onSharedOrigin'];
  onInstanceOrigin: Props['onInstanceOrigin'];
}) {
  const [mode, setMode] = useState<'shared' | 'instance'>('shared');
  const [sx, sy] = seedOf(res, patternId);
  const [x, setX] = useState(String(sx));
  const [y, setY] = useState(String(sy));
  const instances = res.usage.filter((u) => u.fillKind === 'pattern').map((u) => u.object);
  const [nodeId, setNodeId] = useState(instances[0] ?? '');
  const current = overrides[nodeId];
  const [dx, setDx] = useState(String(current?.dx ?? 0));
  const [dy, setDy] = useState(String(current?.dy ?? 0));

  return (
    <div className="origin-row" data-testid={`origin-${patternId}`}>
      <div className="origin-head">
        <code>{patternId}</code>
        <label>
          <input
            type="radio"
            name={`mode-${patternId}`}
            checked={mode === 'shared'}
            onChange={() => setMode('shared')}
            data-testid={`mode-shared-${patternId}`}
          />
          更改公共定义
        </label>
        <label>
          <input
            type="radio"
            name={`mode-${patternId}`}
            checked={mode === 'instance'}
            onChange={() => setMode('instance')}
            data-testid={`mode-instance-${patternId}`}
          />
          仅覆盖某一实例
        </label>
      </div>

      {mode === 'shared' ? (
        <div className="origin-form">
          <label>
            原点 x
            <input type="number" step="1" value={x} onChange={(e) => setX(e.target.value)} data-testid="shared-x" />
          </label>
          <label>
            原点 y
            <input type="number" step="1" value={y} onChange={(e) => setY(e.target.value)} data-testid="shared-y" />
          </label>
          <button
            className="btn"
            onClick={() => onSharedOrigin(patternId, Number(x) || 0, Number(y) || 0)}
            data-testid="apply-shared"
          >
            应用到公共定义
          </button>
          <span className="muted">所有引用实例一起移动</span>
        </div>
      ) : (
        <div className="origin-form">
          <label>
            实例
            <select
              value={nodeId}
              onChange={(e) => {
                setNodeId(e.target.value);
                const cur = overrides[e.target.value];
                setDx(String(cur?.dx ?? 0));
                setDy(String(cur?.dy ?? 0));
              }}
              data-testid="override-target"
            >
              {instances.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label>
            平移 dx
            <input type="number" step="1" value={dx} onChange={(e) => setDx(e.target.value)} data-testid="override-dx" />
          </label>
          <label>
            平移 dy
            <input type="number" step="1" value={dy} onChange={(e) => setDy(e.target.value)} data-testid="override-dy" />
          </label>
          <button
            className="btn"
            onClick={() => onInstanceOrigin(nodeId, Number(dx) || 0, Number(dy) || 0)}
            data-testid="apply-override"
          >
            仅覆盖此实例
          </button>
          {current && (
            <button className="link" onClick={() => onInstanceOrigin(nodeId, 0, 0)} data-testid="clear-override">
              清除覆盖（当前 {current.dx},{current.dy}）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
