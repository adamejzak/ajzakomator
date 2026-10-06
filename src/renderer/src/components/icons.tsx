import { useId, type ReactNode } from 'react';

const Svg = ({ children, size = 14 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const IPlus = () => <Svg><path d="M8 3v10M3 8h10" /></Svg>;
export const IX = () => <Svg size={12}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
export const IMax = () => <Svg size={12}><rect x="3" y="3" width="10" height="10" rx="1.5" /></Svg>;
export const IRestore = () => <Svg size={12}><rect x="3" y="5" width="8" height="8" rx="1.5" /><path d="M6 3h6.5A.5.5 0 0 1 13 3.5V10" /></Svg>;
export const IRestart = () => <Svg size={12}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" /></Svg>;
export const IGrid = () => <Svg><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></Svg>;
export const IHistory = () => <Svg><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 3v2.5H5" /><path d="M8 5.5V8l2 1.5" /></Svg>;
export const ISettings = () => <Svg><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></Svg>;
export const IFolder = () => <Svg><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></Svg>;
export const ISnippet = () => <Svg><path d="M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4M9.5 3l-3 10" /></Svg>;
export const ISidebar = () => <Svg><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></Svg>;
export const ISearch = () => <Svg><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></Svg>;
export const IEdit = () => <Svg size={12}><path d="M10.5 2.5l3 3L6 13H3v-3z" /></Svg>;
export const IBranch = () => <Svg size={11}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></Svg>;
export const IChevron = () => <Svg size={10}><path d="M4 6l4 4 4-4" /></Svg>;

/** App mark: gradient tile with a terminal prompt. */
export function Logo({ size = 18 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ flex: 'none', display: 'block' }}>
      <defs>
        <linearGradient id={`lg${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="0.55" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
        <linearGradient id={`ls${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#lg${id})`} />
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#ls${id})`} />
      <path d="M9.5 11.5l4.5 4.5-4.5 4.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 21h6.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
