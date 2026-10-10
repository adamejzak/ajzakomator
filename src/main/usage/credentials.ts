// src/main/usage/credentials.ts
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { decodeJwtClaims } from './parse';

/** Where credentials come from; replaceable in tests. Everything here is read-only. */
export interface CredentialSource {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** File contents, or null when the file is missing or unreadable. */
  readFile(path: string): Promise<string | null>;
  /** Claude Code's Keychain secret on macOS, or null. */
  keychain(): Promise<string | null>;
}

export function systemCredentialSource(): CredentialSource {
  return {
    env: process.env,
    home: homedir(),
    platform: process.platform,
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    keychain: () => new Promise((resolve) => {
      execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (error, stdout) => {
        resolve(error ? null : stdout.trim() || null);
      });
    }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ClaudeCredentials { accessToken: string; expiresAt?: number; plan?: string }

export function claudePlanLabel(subscriptionType?: unknown, rateLimitTier?: unknown): string | undefined {
  if (typeof subscriptionType !== 'string' || !subscriptionType) return undefined;
  const name = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1).toLowerCase();
  const multiplier = typeof rateLimitTier === 'string' ? /(\d+)x/i.exec(rateLimitTier)?.[1] : undefined;
  return multiplier ? `${name} ${multiplier}x` : name;
}

export async function readClaudeCredentials(source: CredentialSource): Promise<ClaudeCredentials | null> {
  const fromEnv = source.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return { accessToken: fromEnv };
  const directory = source.env.CLAUDE_CONFIG_DIR?.trim() || join(source.home, '.claude');
  let raw = await source.readFile(join(directory, '.credentials.json'));
  if (!raw && source.platform === 'darwin') raw = await source.keychain();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : undefined;
    const token = oauth?.accessToken;
    if (!oauth || typeof token !== 'string' || !token) return null;
    return {
      accessToken: token,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
      plan: claudePlanLabel(oauth.subscriptionType, oauth.rateLimitTier),
    };
  } catch { return null; }
}

export interface CodexCredentials {
  mode: 'chatgpt' | 'apiKey';
  accessToken?: string;
  accountId?: string;
  expiresAt?: number;
  plan?: string;
  email?: string;
}

export async function readCodexCredentials(source: CredentialSource): Promise<CodexCredentials | null> {
  const directory = source.env.CODEX_HOME?.trim() || join(source.home, '.codex');
  const raw = await source.readFile(join(directory, 'auth.json'));
  if (!raw) return null;
  let auth: unknown;
  try { auth = JSON.parse(raw); } catch { return null; }
  if (!isRecord(auth)) return null;
  const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
  const accessToken = typeof tokens?.access_token === 'string' && tokens.access_token ? tokens.access_token : undefined;
  if (!tokens || !accessToken) return typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY ? { mode: 'apiKey' } : null;
  const idClaims = typeof tokens.id_token === 'string' ? decodeJwtClaims(tokens.id_token) : null;
  const accessClaims = decodeJwtClaims(accessToken);
  const authClaim = idClaims?.['https://api.openai.com/auth'] ?? accessClaims?.['https://api.openai.com/auth'];
  const plan = isRecord(authClaim) && typeof authClaim.chatgpt_plan_type === 'string' ? authClaim.chatgpt_plan_type : undefined;
  return {
    mode: 'chatgpt',
    accessToken,
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : undefined,
    expiresAt: typeof accessClaims?.exp === 'number' ? accessClaims.exp * 1000 : undefined,
    plan,
    email: typeof idClaims?.email === 'string' ? idClaims.email : undefined,
  };
}
