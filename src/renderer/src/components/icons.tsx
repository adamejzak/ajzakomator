import type { ReactNode } from 'react';

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

/** App mark: flat white tile with a terminal prompt. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ flex: 'none', display: 'block' }}>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#f4f4f5" />
      <path d="M9.5 11.5l4.5 4.5-4.5 4.5" fill="none" stroke="#0b0b0c" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 21h6.5" stroke="#0b0b0c" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

// Toolbar icons drawn on a 24px grid (crisp at 18px).
const T = ({ children }: { children: ReactNode }) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
export const TGrid = () => (
  <T>
    <rect width="7" height="7" x="3" y="3" rx="1.5" /><rect width="7" height="7" x="14" y="3" rx="1.5" />
    <rect width="7" height="7" x="14" y="14" rx="1.5" /><rect width="7" height="7" x="3" y="14" rx="1.5" />
  </T>
);
export const TPlus = () => <T><path d="M12 5v14M5 12h14" /></T>;
export const THistory = () => (
  <T><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></T>
);
export const TSnippet = () => <T><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></T>;
export const TSidebar = () => <T><rect width="18" height="18" x="3" y="3" rx="2.5" /><path d="M9 3v18" /></T>;
export const TSettings = () => (
  <T>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </T>
);

/** Compact, bold plus for pill buttons. */
export const IPlusBold = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
