// Real-app check of the AI limits panel with a fake home: a fake live Claude login, a local fake usage endpoint and a
// 0.9.0 accounts.json with two records of the live account. Never the real ~/.claude, cswap data or the app data folder.
// Run: npm run build && node scripts/verify-accounts-ui.mjs   Screenshot: D:\Projekty\_shots\091-accounts-panel.png
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { launchApp, scratchRoot, sshState, writeState } from './ssh-ui-lib.mjs';

if (!existsSync('out/main/index.js')) throw new Error('Build first: npm run build');
const root = scratchRoot('accounts');
const home = join(root, 'home');
const seen = [];
// The fake usage endpoint: any other path (a token renewal) is an error, the app must never renew the live login.
const server = createServer((req, res) => {
  seen.push({ path: req.url, ua: String(req.headers['user-agent'] ?? '') });
  if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 7, resets_at: new Date(Date.now() + 86_400_000).toISOString() } }));
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const identity = { emailAddress: 'main@example.com', accountUuid: 'fake-uuid-main', organizationUuid: 'fake-org' };
  const fake = (n) => ({ claudeAiOauth: { accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`, expiresAt: Date.now() + 3_600_000, subscriptionType: 'max' } });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(fake('live')));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: identity }));
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  mkdirSync(join(root, 'data', 'accounts'), { recursive: true });
  writeFileSync(join(root, 'data', 'accounts', 'accounts.json'), JSON.stringify({ claude: ids.map((id, i) => ({ id, email: 'main@example.com', addedAt: i + 1 })) }));
  for (const [i, id] of ids.entries()) {
    const dir = join(root, 'data', 'accounts', 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(fake(`saved-${i}`)));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: identity }));
  }
  const state = sshState({ projectPath: join(root, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(root, state);
  const app = await launchApp(root, {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${server.address().port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${server.address().port}/token`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  });
  try {
    // One card for the account (the duplicate record is set aside), with the numbers from the fake endpoint.
    await app.until(`[...document.querySelectorAll('.usage-card')].filter((c) => c.textContent.includes('main@example.com')).length === 1 && document.body.textContent.includes('42%')`, 'one card with limits');
    await app.until(`[...document.querySelectorAll('.usage-warning button')].some((b) => b.textContent === 'Usuń kopię')`, 'set-aside copy notice');
    await app.screenshot('091-accounts-panel.png');
    // "Ukryj" hides a notice for good: the migration notice goes, the set-aside notice stays.
    const notices = () => app.evaluate(`document.querySelectorAll('.usage-notices .usage-warning').length`);
    const before = await notices();
    await app.evaluate(`(() => { const box = [...document.querySelectorAll('.usage-notices .usage-warning')].find((w) => !w.textContent.includes('Usuń kopię')); [...box.querySelectorAll('button')].find((b) => b.textContent === 'Ukryj').click(); return true; })()`);
    await app.until(`document.querySelectorAll('.usage-notices .usage-warning').length === ${before - 1}`, 'notice dismissed');
    await app.until(`[...document.querySelectorAll('.usage-warning button')].some((b) => b.textContent === 'Usuń kopię')`, 'set-aside notice kept');
    if (!seen.length || !seen.every((r) => r.ua.startsWith('unimux/'))) throw new Error(`usage User-Agent: ${seen.map((r) => r.ua).join(', ')}`);
    if (seen.some((r) => r.path !== '/usage')) throw new Error(`unexpected request: ${seen.map((r) => r.path).join(', ')}`);
  } finally { await app.close(); }
  const stored = readFileSync(join(root, 'data', 'accounts', 'accounts.json'), 'utf8');
  if (/fake-access|fake-refresh/.test(stored)) throw new Error('accounts.json contains a token');
  if (JSON.parse(stored).notices?.some((n) => n.kind === 'migrated')) throw new Error('the dismissed notice is still stored');
  for (const id of ids) if (!existsSync(join(root, 'data', 'accounts', 'claude', id))) throw new Error('a profile dir was deleted');
  console.log('OK accounts');
} finally {
  server.close();
  removeScratch(root);
}

// An accounts.json of the wrong shape: read-only, explained in the panel, never written over.
const roRoot = scratchRoot('accounts-ro');
try {
  mkdirSync(join(roRoot, 'data', 'accounts'), { recursive: true });
  const file = join(roRoot, 'data', 'accounts', 'accounts.json');
  const body = JSON.stringify({ claude: { broken: true } });
  writeFileSync(file, body);
  const state = sshState({ projectPath: join(roRoot, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(roRoot, state);
  const app = await launchApp(roRoot, { MC_USAGE_CLAUDE_URL: 'http://127.0.0.1:9/usage', MC_USAGE_CLAUDE_TOKEN_URL: 'http://127.0.0.1:9/token' });
  try {
    await app.until(`[...document.querySelectorAll('.usage-warning')].some((w) => w.textContent.includes('nie da się bezpiecznie odczytać') && w.textContent.includes('accounts.json'))`, 'read-only explanation');
    // No Claude login can be saved meanwhile: the empty-state button and the "+" entry are disabled, with the reason.
    if (!(await app.evaluate(`[...document.querySelectorAll('.usage-empty-buttons button')].find((b) => b.textContent.includes('Claude'))?.disabled === true`))) throw new Error('Claude button not disabled');
    await app.click('.usage-head button[aria-label="Dodaj konto"]');
    await app.until(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('Dodaj konto Claude') && b.getAttribute('aria-disabled') === 'true') && document.querySelector('.menu').textContent.includes('Niedostępne')`, 'add menu disabled with the reason');
    await app.screenshot('091-accounts-readonly.png');
  } finally { await app.close(); }
  if (readFileSync(file, 'utf8') !== body) throw new Error('a read-only accounts.json was written');
  console.log('OK accounts read-only');
} finally {
  removeScratch(roRoot);
}
