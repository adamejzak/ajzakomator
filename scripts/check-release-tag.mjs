// CI check for tag builds: the tag, package.json, the lock file and the release notes must agree.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'Release tags look like v1.2.3');
const version = tag.slice(1);
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
assert.equal(read('package.json').version, version, `package.json is ${read('package.json').version}, the tag is ${tag}`);
const lock = read('package-lock.json');
assert.equal(lock.version, version, 'package-lock.json version differs from the tag');
assert.equal(lock.packages?.['']?.version, version, 'package-lock.json root package version differs from the tag');

const notesFile = `docs/releases/${version}.md`;
assert.ok(existsSync(notesFile), `Release notes are missing: ${notesFile}`);
const notes = readFileSync(notesFile, 'utf8').replace(/\r\n/g, '\n');
// Existing release notes retain the name and filenames used when they were published.
assert.ok(notes.startsWith(`# unimux ${version}\n`) || notes.startsWith(`# ajzakomator ${version}\n`), `${notesFile} must start with "# unimux ${version}"`);
assert.ok(/^- \S/m.test(notes), `${notesFile} needs at least one bullet point`);
console.log(`Release metadata for ${tag} is consistent.`);
