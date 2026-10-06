// npm run release [patch|minor|major|x.y.z|--current]
// Bumps the version, runs tests, builds locally and publishes the installers to the public
// releases repo (adamejzak/ajzakomator-releases) with the logged-in `gh` CLI. One `gh` call creates
// the release with every asset (avoids electron-builder's parallel publishers racing to create it).
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

const REPO = 'adamejzak/ajzakomator-releases';
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const arg = process.argv[2] ?? 'patch';

if (arg !== '--current') run(`npm version ${arg} --no-git-tag-version`);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;
console.log(`\n▶ ajzakomator ${tag}\n`);

run('npx vitest run');
run('npx electron-vite build');
run('npx electron-builder --win --publish never');

const assets = [
  `release/ajzakomator-Setup-${version}.exe`,
  `release/ajzakomator-Setup-${version}.exe.blockmap`,
  'release/latest.yml', // the auto-updater reads this
  `release/ajzakomator-Portable-${version}.exe`,
];
for (const a of assets) if (!existsSync(a)) throw new Error(`missing build artifact: ${a}`);
const files = assets.map((a) => `"${a}"`).join(' ');

let exists = true;
try {
  execSync(`gh release view ${tag} -R ${REPO}`, { stdio: 'ignore' });
} catch {
  exists = false;
}
if (exists) run(`gh release upload ${tag} ${files} -R ${REPO} --clobber`);
else run(`gh release create ${tag} ${files} -R ${REPO} --title "ajzakomator ${version}" --notes "ajzakomator ${version}" --latest`);

run('git add package.json package-lock.json');
run(`git commit -m "release ${tag}" --allow-empty`);
run(`git tag -f ${tag}`);
console.log(`\n✔ Opublikowano ${tag}: https://github.com/${REPO}/releases/tag/${tag}\n`);
