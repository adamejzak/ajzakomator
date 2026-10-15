// Read-only views of the editor tabs: a table (CSV / TSV / Parquet), an image and a large text file (windowed, so 8 MB stay light).
import { memo, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useFileZoom } from '../fileZoom';
import './fileViews.css';

const BASE_ROW = 20;
const OVERSCAN = 20;

/** A grid of text cells with a sticky header and a row-number column; rows beyond the first screens are windowed. */
export const DataTable = memo(function DataTable({ columns, types, rows, note }: { columns: string[]; types?: string[]; rows: (string | null)[][]; note?: string }) {
  const { tr } = useI18n();
  const ROW_HEIGHT = Math.round(BASE_ROW * useFileZoom());
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  const template = `56px repeat(${columns.length}, minmax(90px, 260px))`;
  return (
    <div className="data-view">
      {note && <div className="preview-notice">{note}</div>}
      <div
        className="data-scroll"
        ref={scroller}
        onScroll={(e) => { setTop(e.currentTarget.scrollTop); setHeight(e.currentTarget.clientHeight); }}
        role="table"
        aria-label={tr('Tabela')}
        aria-rowcount={rows.length + 1}
      >
        <div className="data-row data-head" role="row" style={{ gridTemplateColumns: template }}>
          <span className="data-cell data-index" role="columnheader">#</span>
          {columns.map((name, i) => <span key={i} className="data-cell" role="columnheader" title={types?.[i] ? `${name} · ${types[i]}` : name}>{name}{types?.[i] ? <em>{types[i].toLowerCase()}</em> : null}</span>)}
        </div>
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            return (
              <div key={index} className="data-row" role="row" style={{ gridTemplateColumns: template, top: index * ROW_HEIGHT }}>
                <span className="data-cell data-index" role="cell">{index + 1}</span>
                {columns.map((_, c) => <span key={c} className={`data-cell ${row[c] === null || row[c] === undefined ? 'data-null' : ''}`} role="cell" title={row[c] ?? undefined}>{row[c] ?? 'NULL'}</span>)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export function ImageView({ src, name, size }: { src: string; name: string; size?: number }) {
  const { language } = useI18n();
  const zoom = useFileZoom();
  const [dimensions, setDimensions] = useState<string>('');
  const kb = size === undefined ? '' : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(size / 1024)} KB`;
  return (
    <div className="image-view">
      <div className="image-stage"><img src={src} alt={name} draggable={false} style={zoom === 1 ? undefined : { maxWidth: 'none', maxHeight: 'none', width: `${zoom * 100}%`, objectFit: 'contain' }} onLoad={(e) => setDimensions(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} /></div>
      <div className="image-meta muted">{[dimensions, kb].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

/** Plain text with a line-number gutter, windowed by fixed-height rows (no wrapping). */
export function LargeTextView({ text, notice }: { text: string; notice: string }) {
  const ROW_HEIGHT = Math.round(BASE_ROW * useFileZoom());
  const lines = useMemo(() => text.split('\n'), [text]);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  const digits = String(lines.length).length;
  return (
    <div className="large-view">
      <div className="preview-notice">{notice}</div>
      <div
        className="large-scroll"
        tabIndex={0}
        onScroll={(e) => { setTop(e.currentTarget.scrollTop); setHeight(e.currentTarget.clientHeight); }}
        style={{ ['--digits' as string]: `${digits}ch` }}
      >
        <div style={{ height: lines.length * ROW_HEIGHT, position: 'relative', minWidth: 'max-content' }}>
          {lines.slice(first, last).map((line, offset) => {
            const index = first + offset;
            return (
              <div key={index} className="large-line" style={{ top: index * ROW_HEIGHT }}>
                <span className="large-no">{index + 1}</span>
                <span className="large-code">{line.length > 2000 ? `${line.slice(0, 2000)} …` : line || ' '}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
