import { deflateSync } from 'node:zlib';

export interface Ref {
  id: number;
}

interface Entry {
  body?: string;
  stream?: Uint8Array;
}

export class PdfBuilder {
  private entries: Entry[] = [];

  alloc(): Ref {
    this.entries.push({});
    return { id: this.entries.length };
  }

  set(ref: Ref, body: string): void {
    this.entries[ref.id - 1] = { body };
  }

  stream(ref: Ref, data: Uint8Array, dictEntries = '', compress = true): void {
    const payload = compress ? new Uint8Array(deflateSync(data)) : data;
    const filter = compress ? ' /Filter /FlateDecode' : '';
    this.entries[ref.id - 1] = {
      body: `<< ${dictEntries.trim()}${filter} /Length ${payload.length} >>`,
      stream: payload,
    };
  }

  serialize(rootRef: Ref, infoRef: Ref | null): Uint8Array {
    const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let length = chunks[0].length;
    const offsets: number[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      offsets.push(length);
      if (entry.stream) {
        const head = Buffer.from(`${i + 1} 0 obj\n${entry.body}\nstream\n`, 'latin1');
        const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
        chunks.push(head, Buffer.from(entry.stream), tail);
        length += head.length + entry.stream.length + tail.length;
      } else {
        const buf = Buffer.from(`${i + 1} 0 obj\n${entry.body ?? 'null'}\nendobj\n`, 'latin1');
        chunks.push(buf);
        length += buf.length;
      }
    }
    const xrefStart = length;
    let xref = `xref\n0 ${this.entries.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${this.entries.length + 1} /Root ${rootRef.id} 0 R${infoRef ? ` /Info ${infoRef.id} 0 R` : ''} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return new Uint8Array(Buffer.concat(chunks));
  }
}

export function pdfString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]/g, ' ');
  return `(${escaped})`;
}

export function pdfName(value: string): string {
  return `/${value.replace(/[^\w.+-]/g, (ch) => `#${ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`)}`;
}

export function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}
