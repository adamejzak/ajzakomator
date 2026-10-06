// npm run release [patch|minor|major|x.y.z|--current]
// Bumps the version, runs tests, builds and publishes installers to the public releases repo
// (adamejzak/ajzakomator-releases) using the token of the logged-in `gh` CLI.
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const run = (cmd, env = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
const arg = process.argv[2] ?? 'patch';

if (arg !== '--current') run(`npm version ${arg} --no-git-tag-version`);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
console.log(`\n▶ ajzakomator v${version}\n`);

run('npx vitest run');
run('npx electron-vite build');
const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
run('npx electron-builder --win --publish always', { GH_TOKEN: token });

run('git add package.json package-lock.json');
run(`git commit -m "release v${version}" --allow-empty`);
run(`git tag -f v${version}`);
console.log(`\n✔ Opublikowano v${version}: https://github.com/adamejzak/ajzakomator-releases/releases/tag/v${version}\n`);
