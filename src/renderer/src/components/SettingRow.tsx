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

/** A titled card of settings; a page with several topics shows several of them. */
export function SettingsGroup({ title, description, children }: { title?: ReactNode; description?: ReactNode; children: ReactNode }) {
  return <section className="settings-group">
    {title && <h3 className="settings-group-title">{title}</h3>}
    {description && <p className="settings-group-desc">{description}</p>}
    <div className="settings-card">{children}</div>
  </section>;
}
