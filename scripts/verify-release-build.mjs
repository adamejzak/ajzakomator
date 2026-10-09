import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const { RELEASE_TAG: tag, BUILD_RUN_ID: runId, RELEASE_REPOSITORY: repository } = process.env;
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/);
assert.match(runId ?? '', /^\d+$/);
assert.ok(repository);
const exec = (command, args) => execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim();
const api = path => JSON.parse(exec('gh', ['api', `repos/${repository}/${path}`]));
const commit = exec('git', ['rev-parse', `${tag}^{commit}`]);
const source = JSON.parse(exec('git', ['show', `${tag}:package.json`]));
assert.equal(source.version, tag.slice(1));
assert.ok(existsSync(`docs/releases/${source.version}.md`), 'Release notes are missing');
const run = api(`actions/runs/${runId}`);
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'success');
assert.equal(run.name, 'CI');
assert.equal(run.repository.full_name, repository);
assert.equal(run.head_sha, commit, 'Build and tag must point to the same commit');
const { jobs } = api(`actions/runs/${runId}/jobs`);
const expected = ['Windows x64', 'macOS Apple Silicon', 'macOS Intel'];
assert.equal(jobs.length, expected.length);
for (const name of expected) {
  assert.equal(jobs.find(job => job.name === name)?.conclusion, 'success', `${name} did not pass`);
}
console.log(`Verified ${tag}: all three platform builds passed at ${commit}.`);
