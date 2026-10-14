import type { ReactNode } from 'react';

export function SettingRow({ title, hint, htmlFor, children }: { title: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return <div className="setting-row">
    <div className="setting-copy">
      <label htmlFor={htmlFor}>{title}</label>
      {hint && <div className="setting-hint">{hint}</div>}
    </div>
    <div className="setting-control">{children}</div>
  </div>;
}
