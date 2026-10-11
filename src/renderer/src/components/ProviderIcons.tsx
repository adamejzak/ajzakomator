import type { UsageProvider } from '../../../shared/usage';

/** Claude: an asterisk in the brand orange. Codex: a hexagon with a terminal prompt. */
export function ProviderIcon({ provider, size = 16 }: { provider: UsageProvider; size?: number }) {
  return provider === 'claude' ? (
    <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#d97757" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
      <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" />
    </svg>
  ) : (
    <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#e5e5e5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2.8l7.8 4.5v9.4L12 21.2l-7.8-4.5V7.3z" />
      <path d="M9 10.2l2.6 1.9L9 14M13.4 14.2h2.4" />
    </svg>
  );
}
