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

// A saved card that a (fake) cswap roster lists: "Make main account" swaps a fresh copy in without any token request and
// refuses a copy that would need renewing, with the text that says what to do (final review I3).
const cswapRoot = scratchRoot('accounts-cswap');
const cswapSeen = [];
const cswapServer = createServer((req, res) => {
  cswapSeen.push(req.url);
  if (req.url !== '/usage') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ five_hour: { utilization: 11, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 3, resets_at: new Date(Date.now() + 86_400_000).toISOString() } }));
});
try {
  await new Promise((resolve) => cswapServer.listen(0, '127.0.0.1', resolve));
  const home = join(cswapRoot, 'home');
  const who = (name) => ({ emailAddress: `${name}@example.com`, accountUuid: `fake-uuid-${name}`, organizationUuid: `fake-org-${name}` });
  const fake = (n, expiresAt) => ({ claudeAiOauth: { accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`, expiresAt, subscriptionType: 'max' } });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(fake('live', Date.now() + 3_600_000)));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: who('main') }));
  mkdirSync(join(home, '.claude-swap-backup'), { recursive: true });
  writeFileSync(join(home, '.claude-swap-backup', 'sequence.json'), JSON.stringify({ accounts: { 1: { email: 'fresh@example.com', uuid: 'fake-uuid-fresh' }, 2: { email: 'stale@example.com', uuid: 'fake-uuid-stale' } } }));
  // 0.9.0 records (no family: a copy of the live family cswap may hold).
  const saved = [['33333333-3333-4333-8333-333333333333', 'fresh', Date.now() + 3_600_000], ['44444444-4444-4444-8444-444444444444', 'stale', Date.now() + 2 * 60_000]];
  mkdirSync(join(cswapRoot, 'data', 'accounts'), { recursive: true });
  writeFileSync(join(cswapRoot, 'data', 'accounts', 'accounts.json'), JSON.stringify({ claude: saved.map(([id, name], i) => ({ id, email: `${name}@example.com`, addedAt: i + 1 })) }));
  for (const [id, name, expiresAt] of saved) {
    const dir = join(cswapRoot, 'data', 'accounts', 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(fake(name, expiresAt)));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: who(name) }));
  }
  const state = sshState({ projectPath: join(cswapRoot, 'project') });
  state.settings = { ...state.settings, showAiUsage: true, usageCollapsed: false };
  writeState(cswapRoot, state);
  const app = await launchApp(cswapRoot, {
    MC_USAGE_CLAUDE_URL: `http://127.0.0.1:${cswapServer.address().port}/usage`, MC_USAGE_CLAUDE_TOKEN_URL: `http://127.0.0.1:${cswapServer.address().port}/token`,
    CLAUDE_CONFIG_DIR: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null, CODEX_HOME: null,
  });
  const card = (name) => `[...document.querySelectorAll('.usage-card')].find((c) => c.textContent.includes('${name}@example.com'))`;
  const makeMain = async (name) => {
    await app.evaluate(`${card(name)}.querySelector('.usage-kebab').click()`);
    await app.until(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('Ustaw jako główne'))`, `make main offered for ${name}`);
    await app.evaluate(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Ustaw jako główne')).click()`);
    await app.until(`[...document.querySelectorAll('.modal-foot button')].some((b) => b.textContent === 'Ustaw jako główne')`, 'confirmation');
    await app.evaluate(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Ustaw jako główne').click()`);
  };
  try {
    await app.until(`!!${card('fresh')} && !!${card('stale')} && ${card('fresh')}.textContent.includes('cswap też trzyma kopię')`, 'cswap cards with the hint');
    await app.screenshot('091-accounts-cswap-hint.png');
    await makeMain('stale');
    await app.until(`document.body.textContent.includes('Konto stale@example.com jest zarządzane poza aplikacją')`, 'stale copy refused with the foreign text');
    await app.screenshot('091-accounts-cswap-stale.png');
    if (JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken !== 'fake-access-live') throw new Error('a refused swap changed the live login');
    await makeMain('fresh');
    await app.until(`document.body.textContent.includes('Konto główne: fresh@example.com')`, 'fresh copy swapped in');
    await app.until(`${card('fresh')}?.querySelector('.usage-chip.main') !== null`, 'fresh card is main');
    await app.screenshot('091-accounts-cswap-fresh.png');
  } finally { await app.close(); }
  const live = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;
  if (live !== 'fake-access-fresh') throw new Error(`live login after the swap: ${live}`);
  if (cswapSeen.some((path) => path !== '/usage')) throw new Error(`token request: ${cswapSeen.join(', ')}`);
  console.log('OK accounts cswap make main');
} finally {
  cswapServer.close();
  removeScratch(cswapRoot);
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
