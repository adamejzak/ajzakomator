import { IFile } from './icons';
import './file-workspace.css';

type FileType = { label: string; color: string; symbol?: 'react' | 'markdown' | 'image' | 'code' };

const fileTypes: Record<string, FileType> = {
  ts: { label: 'TS', color: '#65a9ef' }, tsx: { label: 'TSX', color: '#65c9ec', symbol: 'react' },
  mts: { label: 'TS', color: '#65a9ef' }, cts: { label: 'TS', color: '#65a9ef' },
  js: { label: 'JS', color: '#e5ca67' }, jsx: { label: 'JSX', color: '#65c9ec', symbol: 'react' },
  mjs: { label: 'JS', color: '#e5ca67' }, cjs: { label: 'JS', color: '#e5ca67' },
  json: { label: '{}', color: '#e5ca67' }, jsonc: { label: '{}', color: '#e5ca67' },
  md: { label: 'MD', color: '#8cb9e8', symbol: 'markdown' }, markdown: { label: 'MD', color: '#8cb9e8', symbol: 'markdown' },
  css: { label: '#', color: '#a69aee' }, scss: { label: '#', color: '#df8bb6' }, sass: { label: '#', color: '#df8bb6' },
  html: { label: '<>', color: '#e99c77', symbol: 'code' }, htm: { label: '<>', color: '#e99c77', symbol: 'code' },
  vue: { label: 'V', color: '#7fcaa0' }, svelte: { label: 'S', color: '#ee9975' },
  py: { label: 'PY', color: '#dfc77b' }, pyw: { label: 'PY', color: '#dfc77b' },
  yml: { label: 'Y', color: '#d59ab5' }, yaml: { label: 'Y', color: '#d59ab5' },
  toml: { label: '=', color: '#c39e8b' }, ini: { label: '=', color: '#aab8c7' }, conf: { label: '=', color: '#aab8c7' },
  sh: { label: '$', color: '#92c797' }, bash: { label: '$', color: '#92c797' }, zsh: { label: '$', color: '#92c797' },
  ps1: { label: '>_', color: '#80b9ec' }, bat: { label: '>_', color: '#92c797' }, cmd: { label: '>_', color: '#92c797' },
  rs: { label: 'R', color: '#dba382' }, go: { label: 'GO', color: '#72c9d7' },
  c: { label: 'C', color: '#8faee5' }, h: { label: 'H', color: '#a69aee' },
  cpp: { label: 'C+', color: '#8faee5' }, hpp: { label: 'H+', color: '#a69aee' },
  cs: { label: 'C#', color: '#b292d5' }, java: { label: 'J', color: '#df9d77' },
  sql: { label: 'DB', color: '#e2bd7a' }, db: { label: 'DB', color: '#e2bd7a' },
  svg: { label: 'SVG', color: '#dcb76c', symbol: 'image' }, png: { label: 'IMG', color: '#a8c88a', symbol: 'image' },
  jpg: { label: 'IMG', color: '#a8c88a', symbol: 'image' }, jpeg: { label: 'IMG', color: '#a8c88a', symbol: 'image' },
  gif: { label: 'IMG', color: '#a8c88a', symbol: 'image' }, webp: { label: 'IMG', color: '#a8c88a', symbol: 'image' },
  ico: { label: 'IMG', color: '#a8c88a', symbol: 'image' },
  txt: { label: 'TXT', color: '#aab8c7' }, log: { label: 'LOG', color: '#aab8c7' },
  pdf: { label: 'PDF', color: '#e18c8c' }, lock: { label: 'L', color: '#b3a18a' },
};

/** Decorative, consistent file-type marks for the tree and editor breadcrumb. */
export function FileIcon({ name }: { name: string }) {
  const basename = name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const extension = basename.includes('.') ? basename.split('.').pop() ?? '' : '';
  const type: FileType | undefined = basename === 'dockerfile' ? { label: 'D', color: '#80b9ec' }
    : basename === '.gitignore' || basename === '.gitattributes' ? { label: 'G', color: '#e99c77' }
    : basename === '.env' || basename.startsWith('.env.') ? { label: '=', color: '#dfc77b' }
    : fileTypes[extension];
  return (
    <span className="file-type-icon" style={{ color: type?.color ?? '#9aa4b2' }} aria-hidden="true">
      {!type ? <IFile /> : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          {type.symbol === 'react' ? <g stroke="currentColor" strokeWidth="1">
            <ellipse cx="8" cy="8" rx="7" ry="2.6" /><ellipse cx="8" cy="8" rx="7" ry="2.6" transform="rotate(60 8 8)" />
            <ellipse cx="8" cy="8" rx="7" ry="2.6" transform="rotate(120 8 8)" /><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
          </g> : type.symbol === 'markdown' ? <g stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
            <rect x="1" y="3" width="14" height="10" rx="1.4" /><path d="M3 10V6l2 2 2-2v4M11 6v4m-2-2 2 2 2-2" />
          </g> : type.symbol === 'image' ? <g stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
            <rect x="2" y="2" width="12" height="12" rx="2" /><circle cx="5.5" cy="5.5" r="1" /><path d="m3 12 4-4 2.5 2L12 7l2 3" />
          </g> : type.symbol === 'code' ? <path d="m5.5 4-4 4 4 4m5-8 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> : <>
            <rect x="1" y="1" width="14" height="14" rx="2.5" fill="currentColor" fillOpacity=".12" />
            <text x="8" y="11" fill="currentColor" textAnchor="middle" fontFamily="'Segoe UI', sans-serif" fontSize={type.label.length > 2 ? '6.5' : '8'} fontWeight="700">{type.label}</text>
          </>}
        </svg>
      )}
    </span>
  );
}

export function FileBreadcrumb({ projectName, relativePath, fullPath }: { projectName?: string; relativePath: string; fullPath: string }) {
  const parts = [...(projectName ? [projectName] : []), ...relativePath.split(/[\\/]/).filter(Boolean)];
  return <nav className="file-breadcrumb" aria-label={fullPath} title={fullPath}>
    <ol>{parts.map((part, index) => <li key={index} aria-current={index === parts.length - 1 ? 'page' : undefined}>
      {index > 0 && <svg className="breadcrumb-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>}
      {index === parts.length - 1 && <FileIcon name={relativePath} />}
      <span className="breadcrumb-name">{part}</span>
    </li>)}</ol>
  </nav>;
}

export function FileActionIcon({ kind }: { kind: 'save' | 'wrap' }) {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'save' ? <><path d="M12 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V4z" /><path d="M5 2v4h6V2M5 14V9h6v5" /></> : <><path d="M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8M2 12h3" /><path d="m10 11-2 2 2 2" /></>}
  </svg>;
}
