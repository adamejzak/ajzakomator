// src/main/accounts/store.ts
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isAccountId, type ManagedAccount } from '../../shared/accounts';

const MAX_TEXT = 120;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined;
}

/** The same field rules `list` applies, so a stored entry always survives a reload. */
function sanitize(account: ManagedAccount): ManagedAccount {
  const { email, org, ...rest } = account;
  const clean: ManagedAccount = { ...rest };
  const e = optionalText(email);
  const o = optionalText(org);
  if (e !== undefined) clean.email = e;
  if (o !== undefined) clean.org = o;
  return clean;
}

function parseAccount(value: unknown): ManagedAccount | null {
  if (!isRecord(value) || !isAccountId(value.id)) return null;
  if (typeof value.addedAt !== 'number' || !Number.isFinite(value.addedAt)) return null;
  const account: ManagedAccount = { id: value.id, addedAt: value.addedAt };
  const email = optionalText(value.email);
  const org = optionalText(value.org);
  if (email !== undefined) account.email = email;
  if (org !== undefined) account.org = org;
  return account;
}

/** Claude accounts added in the app; each lives in `<root>/claude/<uuid>` and is listed in `<root>/accounts.json`. */
export class AccountsStore {
  private readonly file: string;

  constructor(private readonly root: string) {
    this.file = join(root, 'accounts.json');
  }

  list(): ManagedAccount[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!isRecord(parsed) || !Array.isArray(parsed.claude)) return [];
      return parsed.claude.map(parseAccount).filter((account): account is ManagedAccount => account !== null);
    } catch { return []; }
  }

  dirOf(id: string): string {
    if (!isAccountId(id)) throw new Error('invalid account id');
    return join(this.root, 'claude', id);
  }

  /** Creates the profile directory for a login in progress; the account is not listed until `commit`. */
  prepare(): { id: string; dir: string } {
    const id = randomUUID();
    const dir = this.dirOf(id);
    mkdirSync(dir, { recursive: true });
    return { id, dir };
  }

  commit(account: ManagedAccount): void {
    const accounts = this.list();
    const clean = sanitize(account);
    const index = accounts.findIndex((entry) => entry.id === clean.id);
    if (index >= 0) accounts[index] = clean;
    else accounts.push(clean);
    this.write(accounts);
  }

  update(id: string, patch: Partial<Pick<ManagedAccount, 'email' | 'org'>>): void {
    const accounts = this.list();
    const index = accounts.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    accounts[index] = sanitize({ ...accounts[index], ...patch });
    this.write(accounts);
  }

  remove(id: string): void {
    if (!isAccountId(id)) return;
    rmSync(this.dirOf(id), { recursive: true, force: true });
    const accounts = this.list();
    const rest = accounts.filter((entry) => entry.id !== id);
    if (rest.length !== accounts.length) this.write(rest);
  }

  private write(accounts: ManagedAccount[]): void {
    mkdirSync(this.root, { recursive: true });
    this.backUpCorrupt();
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ claude: accounts }, null, 2));
      renameSync(temp, this.file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  /** An unparsable accounts.json is kept as accounts.json.bak instead of being silently overwritten. */
  private backUpCorrupt(): void {
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch { return; }
    try { JSON.parse(text); } catch {
      try { renameSync(this.file, `${this.file}.bak`); } catch { /* best effort */ }
    }
  }
}
