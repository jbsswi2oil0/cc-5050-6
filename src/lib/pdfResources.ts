/**
 * 从导出的 PDF 字节里回读资源表：对象表、页面资源字典、内容流里的
 * 标记内容 / 路径 / 填充引用，以及 Form XObject 的递归展开。
 * 不依赖内存中的场景图——只读 PDF 本身，用来确认成品仍可编辑、资源确实共享。
 */

export type Inflater = (data: Uint8Array) => Promise<Uint8Array>;

export interface PaintRef {
  kind: 'solid' | 'pattern' | 'none';
  color?: [number, number, number];
  name?: string;
  objectId?: number;
}

export interface MarkedPathInfo {
  d: string;
  ctm: number[];
  paint: 'fill' | 'fill-evenodd' | 'stroke';
  fill: PaintRef | null;
}

export interface MarkedObjectInfo {
  id: string;
  paths: MarkedPathInfo[];
  formsUsed: { name: string; objectId: number }[];
  patternsUsed: { name: string; objectId: number }[];
}

export interface PatternObjectInfo {
  objectId: number;
  name: string | null;
  type: number;
  matrix: number[] | null;
  xstep: number | null;
  ystep: number | null;
  bbox: number[] | null;
  shadingRef: number | null;
  cellFormRef: number | null;
  cellFormName: string | null;
}

export interface ShadingObjectInfo {
  objectId: number;
  coords: number[];
  stopCount: number;
  firstColor: number[];
  lastColor: number[];
}

export interface FormObjectInfo {
  objectId: number;
  matrix: number[] | null;
  bbox: number[];
}

export interface PdfResourceReport {
  patterns: PatternObjectInfo[];
  shadings: ShadingObjectInfo[];
  forms: FormObjectInfo[];
  markedObjects: MarkedObjectInfo[];
  pagePatterns: Record<string, number>;
  pageXObjects: Record<string, number>;
  pageGStates: Record<string, number>;
}

interface PdfObject {
  id: number;
  head: string;
  stream: string | null;
  inflated: boolean;
}

type Matrix6 = [number, number, number, number, number, number];

const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix6, n: Matrix6): Matrix6 {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function bytesToLatin1(b: Uint8Array): string {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, Math.min(b.length, i + CHUNK)));
  }
  return s;
}

/** 浏览器端 FlateDecode 解压（zlib 封装格式）。 */
export async function inflateBrowser(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function readPdfResources(bytes: Uint8Array, inflate: Inflater): Promise<PdfResourceReport> {
  const text = bytesToLatin1(bytes);
  const objects = new Map<number, PdfObject>();

  const objRe = /(\d+) 0 obj\b/g;
  const starts: { id: number; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text))) starts.push({ id: Number(m[1]), index: m.index });

  for (let i = 0; i < starts.length; i++) {
    const { id, index } = starts[i];
    const limit = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const body = text.slice(index, limit);
    const streamIdx = body.indexOf('stream');
    const endobjIdx = body.indexOf('endobj');
    if (streamIdx >= 0 && (endobjIdx < 0 || streamIdx < endobjIdx)) {
      const head = body.slice(0, streamIdx);
      let dataStart = streamIdx + 'stream'.length;
      if (body[dataStart] === '\r' && body[dataStart + 1] === '\n') dataStart += 2;
      else if (body[dataStart] === '\n') dataStart += 1;
      const endStream = body.indexOf('endstream', dataStart);
      const raw = body.slice(dataStart, endStream >= 0 ? endStream : undefined);
      objects.set(id, { id, head, stream: raw, inflated: false });
    } else {
      objects.set(id, { id, head: body.slice(0, endobjIdx >= 0 ? endobjIdx : undefined), stream: null, inflated: false });
    }
  }

  // 解压所有 FlateDecode 流
  for (const obj of objects.values()) {
    if (obj.stream != null && /FlateDecode/.test(obj.head)) {
      const decoded = await inflate(latin1ToBytes(obj.stream.replace(/\r?\n$/, '')));
      obj.stream = bytesToLatin1(decoded);
      obj.inflated = true;
    }
  }

  // 页面对象与页面资源
  const pageObj = [...objects.values()].find((o) => /\/Type\s*\/Page\b/.test(o.head) && !/\/Type\s*\/Pages\b/.test(o.head));
  if (!pageObj) throw new Error('PDF 中找不到页面对象');
  const pageResources = parseResourceDicts(pageObj.head);
  const contentsRef = pageObj.head.match(/\/Contents\s+(\d+)\s+0\s+R/);
  if (!contentsRef) throw new Error('页面缺少 /Contents');
  const content = objects.get(Number(contentsRef[1]))?.stream ?? '';

  // 收集 Pattern / Shading / Form 对象信息
  const patterns: PatternObjectInfo[] = [];
  const shadings: ShadingObjectInfo[] = [];
  const forms: FormObjectInfo[] = [];

  for (const obj of objects.values()) {
    if (/\/PatternType\s+(\d+)/.test(obj.head)) {
      const type = Number(obj.head.match(/\/PatternType\s+(\d+)/)![1]);
      const matrix = parseNumberArray(obj.head, /\/Matrix\s*\[([^\]]*)\]/);
      const bbox = parseNumberArray(obj.head, /\/BBox\s*\[([^\]]*)\]/);
      const xstep = parseNumber(obj.head, /\/XStep\s+(-?[\d.]+)/);
      const ystep = parseNumber(obj.head, /\/YStep\s+(-?[\d.]+)/);
      const shadingRef = obj.head.match(/\/Shading\s+(\d+)\s+0\s+R/);
      let cellFormRef: number | null = null;
      let cellFormName: string | null = null;
      if (obj.stream) {
        const doMatch = obj.stream.match(/\/([\w.+-]+)\s+Do/);
        if (doMatch) {
          cellFormName = doMatch[1];
          const xobjs = parseResourceDicts(obj.head).xobjects;
          if (xobjs[cellFormName] != null) cellFormRef = xobjs[cellFormName];
        }
      }
      patterns.push({
        objectId: obj.id,
        name: nameOf(pageResources.patterns, obj.id),
        type,
        matrix,
        xstep,
        ystep,
        bbox,
        shadingRef: shadingRef ? Number(shadingRef[1]) : null,
        cellFormRef,
        cellFormName,
      });
    } else if (/\/ShadingType\s+\d/.test(obj.head)) {
      const coords = parseNumberArray(obj.head, /\/Coords\s*\[([^\]]*)\]/) ?? [];
      shadings.push({
        objectId: obj.id,
        coords,
        ...readStops(obj, objects),
      });
    } else if (/\/Subtype\s*\/Form\b/.test(obj.head)) {
      forms.push({
        objectId: obj.id,
        matrix: parseNumberArray(obj.head, /\/Matrix\s*\[([^\]]*)\]/),
        bbox: parseNumberArray(obj.head, /\/BBox\s*\[([^\]]*)\]/) ?? [],
      });
    }
  }

  // 内容流状态机：标记内容 + 路径 + 填充引用（递归展开 Form XObject）
  const markedObjects: MarkedObjectInfo[] = [];
  const markedById = new Map<string, MarkedObjectInfo>();

  interface Scope {
    patterns: Record<string, number>;
    xobjects: Record<string, number>;
  }
  interface Frame {
    ctm: Matrix6;
    fill: PaintRef;
    fillIsPatternCS: boolean;
  }

  const pageScope: Scope = { patterns: pageResources.patterns, xobjects: pageResources.xobjects };

  const ensureMarked = (id: string): MarkedObjectInfo => {
    let obj = markedById.get(id);
    if (!obj) {
      obj = { id, paths: [], formsUsed: [], patternsUsed: [] };
      markedById.set(id, obj);
      markedObjects.push(obj);
    }
    return obj;
  };

  // 标记内容栈跨 Form 递归共享：Form 内的绘制归属于外层 BMC 标记的对象
  const marked: string[] = [];

  const walkContent = (stream: string, initialCtm: Matrix6, scope: Scope, depth: number): void => {
    if (depth > 8) return;
    const stack: Frame[] = [{ ctm: initialCtm, fill: { kind: 'none' }, fillIsPatternCS: false }];
    let path: string[] = [];
    let nums: number[] = [];
    let lastName: string | null = null;

    const top = () => stack[stack.length - 1];
    const currentMarked = (): MarkedObjectInfo | null =>
      marked.length ? ensureMarked(marked[marked.length - 1]) : null;

    for (const tok of tokenize(stream)) {
      if (tok.t === 'num') {
        nums.push(tok.v);
        continue;
      }
      if (tok.t === 'name') {
        lastName = tok.v;
        continue;
      }
      if (tok.t !== 'op') {
        nums = [];
        continue;
      }
      const op = tok.v;
      const take = (n: number): number[] => {
        const out = nums.slice(Math.max(0, nums.length - n));
        nums = [];
        return out;
      };
      switch (op) {
        case 'q':
          stack.push({ ...top() });
          nums = [];
          break;
        case 'Q':
          if (stack.length > 1) stack.pop();
          nums = [];
          break;
        case 'cm': {
          const a = take(6);
          if (a.length === 6) top().ctm = mul(top().ctm, a as Matrix6);
          break;
        }
        case 'BMC':
        case 'BDC': {
          if (lastName) {
            marked.push(lastName);
            ensureMarked(lastName);
          }
          nums = [];
          break;
        }
        case 'EMC':
          marked.pop();
          nums = [];
          break;
        case 'rg': {
          const c = take(3);
          top().fill = { kind: 'solid', color: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0] };
          top().fillIsPatternCS = false;
          break;
        }
        case 'cs':
          top().fillIsPatternCS = lastName === 'Pattern';
          nums = [];
          break;
        case 'scn':
        case 'sc': {
          if (top().fillIsPatternCS && lastName) {
            const objectId = scope.patterns[lastName];
            top().fill = { kind: 'pattern', name: lastName, objectId };
            const markedObj = currentMarked();
            if (markedObj && objectId != null && !markedObj.patternsUsed.some((p) => p.objectId === objectId)) {
              markedObj.patternsUsed.push({ name: lastName, objectId });
            }
          }
          nums = [];
          break;
        }
        case 'm': {
          const [x, y] = take(2);
          path.push(`M${fmt(x)} ${fmt(y)}`);
          break;
        }
        case 'l': {
          const [x, y] = take(2);
          path.push(`L${fmt(x)} ${fmt(y)}`);
          break;
        }
        case 'c': {
          const a = take(6);
          path.push(`C${a.map(fmt).join(' ')}`);
          break;
        }
        case 'h':
          path.push('Z');
          nums = [];
          break;
        case 're':
          path = [];
          nums = [];
          break;
        case 'W':
        case 'W*':
        case 'n':
          path = [];
          nums = [];
          break;
        case 'f':
        case 'f*':
        case 'F':
        case 'S':
        case 's': {
          const target = currentMarked();
          if (target && path.length) {
            target.paths.push({
              d: path.join(' '),
              ctm: [...top().ctm],
              paint: op === 'f*' ? 'fill-evenodd' : op === 'S' || op === 's' ? 'stroke' : 'fill',
              fill: top().fill.kind === 'none' ? null : { ...top().fill },
            });
          }
          path = [];
          nums = [];
          break;
        }
        case 'Do': {
          const name = lastName;
          const objectId = name ? scope.xobjects[name] : undefined;
          if (name && objectId != null) {
            const markedObj = currentMarked();
            if (markedObj && !markedObj.formsUsed.some((f) => f.objectId === objectId)) {
              markedObj.formsUsed.push({ name, objectId });
            }
            const form = objects.get(objectId);
            if (form?.stream && /\/Subtype\s*\/Form\b/.test(form.head)) {
              const fm = parseNumberArray(form.head, /\/Matrix\s*\[([^\]]*)\]/);
              const sub = parseResourceDicts(form.head);
              walkContent(
                form.stream,
                mul(top().ctm, (fm ?? IDENTITY) as Matrix6),
                { patterns: sub.patterns, xobjects: sub.xobjects },
                depth + 1,
              );
            }
          }
          nums = [];
          break;
        }
        default:
          nums = [];
          break;
      }
      if (op !== 'cs' && op !== 'scn' && op !== 'sc') lastName = null;
    }
  };

  walkContent(content, IDENTITY, pageScope, 0);

  return {
    patterns,
    shadings,
    forms,
    markedObjects,
    pagePatterns: pageResources.patterns,
    pageXObjects: pageResources.xobjects,
    pageGStates: pageResources.gstates,
  };
}

interface Token {
  t: 'num' | 'name' | 'op' | 'other';
  v: string;
}

function* tokenize(s: string): Generator<Token & { v: string } & ({ t: 'num'; v: number } | { t: 'name' | 'op' | 'other'; v: string })> {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') {
      i++;
      continue;
    }
    if (ch === '%') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (s[i] === '\\') i += 2;
        else if (s[i] === '(') { depth++; i++; }
        else if (s[i] === ')') { depth--; i++; }
        else i++;
      }
      continue;
    }
    if (ch === '[') {
      while (i < n && s[i] !== ']') i++;
      i++;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !/[\s\[\]()/<>]/.test(s[j])) j++;
      yield { t: 'name', v: s.slice(i + 1, j) };
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !/[\s\[\]()/<>]/.test(s[j])) j++;
    const word = s.slice(i, j);
    i = j;
    if (/^-?[\d.]+(?:e[-+]?\d+)?$/i.test(word)) {
      yield { t: 'num', v: Number(word) } as Token & { t: 'num'; v: number };
    } else {
      yield { t: 'op', v: word };
    }
  }
}

/** 从字典文本里提取 /Pattern、/XObject、/ExtGState 三个资源子字典（名字 → 对象号）。 */
function parseResourceDicts(head: string): {
  patterns: Record<string, number>;
  xobjects: Record<string, number>;
  gstates: Record<string, number>;
} {
  const out = { patterns: {} as Record<string, number>, xobjects: {} as Record<string, number>, gstates: {} as Record<string, number> };
  for (const [key, target] of [
    ['/Pattern', 'patterns'],
    ['/XObject', 'xobjects'],
    ['/ExtGState', 'gstates'],
  ] as const) {
    const dict = extractDict(head, key);
    if (!dict) continue;
    const re = /\/([\w.+-]+)\s+(\d+)\s+0\s+R/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(dict))) {
      out[target][m[1]] = Number(m[2]);
    }
  }
  return out;
}

/** 提取 /Key 之后配平的 << ... >> 子串。 */
function extractDict(text: string, key: string): string | null {
  const idx = text.indexOf(key);
  if (idx < 0) return null;
  const open = text.indexOf('<<', idx + key.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length - 1; i += 2) {
    const pair = text.slice(i, i + 2);
    if (pair === '<<') depth++;
    else if (pair === '>>') {
      depth--;
      if (depth === 0) return text.slice(open, i + 2);
    }
  }
  return null;
}

function parseNumberArray(text: string, re: RegExp): number[] | null {
  const m = text.match(re);
  if (!m) return null;
  const nums = m[1].trim().split(/[\s,]+/).filter(Boolean).map(Number);
  return nums.every(Number.isFinite) ? nums : null;
}

function parseNumber(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function nameOf(dict: Record<string, number>, objectId: number): string | null {
  for (const [name, id] of Object.entries(dict)) if (id === objectId) return name;
  return null;
}

function readStops(
  shading: { head: string },
  objects: Map<number, PdfObject>,
): { stopCount: number; firstColor: number[]; lastColor: number[] } {
  const fnMatch = shading.head.match(/\/Function\s+(\d+)\s+0\s+R/);
  if (fnMatch) {
    const fn = objects.get(Number(fnMatch[1]));
    const c0 = fn ? parseNumberArray(fn.head, /\/C0\s*\[([^\]]*)\]/) : null;
    const c1 = fn ? parseNumberArray(fn.head, /\/C1\s*\[([^\]]*)\]/) : null;
    return { stopCount: 2, firstColor: c0 ?? [], lastColor: c1 ?? [] };
  }
  const inline = extractDict(shading.head, '/Function');
  if (inline && /\/FunctionType\s+3/.test(inline)) {
    const bounds = parseNumberArray(inline, /\/Bounds\s*\[([^\]]*)\]/) ?? [];
    const fnIds = [...inline.matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
    const first = fnIds.length ? objects.get(fnIds[0]) : undefined;
    const last = fnIds.length ? objects.get(fnIds[fnIds.length - 1]) : undefined;
    return {
      // N 段子函数 → N+1 个色标；Bounds 有 N-1 条
      stopCount: bounds.length + 2,
      firstColor: first ? parseNumberArray(first.head, /\/C0\s*\[([^\]]*)\]/) ?? [] : [],
      lastColor: last ? parseNumberArray(last.head, /\/C1\s*\[([^\]]*)\]/) ?? [] : [],
    };
  }
  return { stopCount: 0, firstColor: [], lastColor: [] };
}

function fmt(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '0';
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}
