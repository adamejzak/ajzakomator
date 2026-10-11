// src/main/accounts/identity.ts
import { profileSource, readClaudeIdentity, type CredentialSource } from '../usage/credentials';

export interface IdentityDeps {
  source: CredentialSource;
  exec(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null>;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** Who is logged in to a managed profile: the profile's `.claude.json` first, then `claude auth status`. */
export async function readManagedIdentity(dir: string, deps: IdentityDeps): Promise<{ email?: string; org?: string; plan?: string }> {
  const fromFile = await readClaudeIdentity(profileSource(deps.source, dir));
  if (fromFile.email) return fromFile;
  try {
    const raw = await deps.exec('claude', ['auth', 'status', '--json'], { ...deps.source.env, CLAUDE_CONFIG_DIR: dir });
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || (parsed as { loggedIn?: unknown }).loggedIn !== true) return {};
    const status = parsed as Record<string, unknown>;
    return { email: text(status.email), org: text(status.orgName), plan: text(status.subscriptionType) };
  } catch { return {}; }
}
