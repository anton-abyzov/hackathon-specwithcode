import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FIXTURE_MANIFEST_SHA256, loadReviewedFixtureManifest, readProtectedBaseline, validateFixtureManifest, verifyFixtureTree } from './fixture-preservation-audit.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = 'scripts/studio-toolchain/reviewed-fixture-migrations.json';
const pinnedBytes = readFileSync(join(sourceRoot, manifestPath));
const pinnedManifest = JSON.parse(pinnedBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reviewedPath = 'app/fixtures/reviewed.ndjson';
const oldRecording = '{"clientInfo":{"name":"T3 Code"},"user_request":"Keep this exact user prose: café.","id":"message-7"}\n';
const reviewedRecording = oldRecording.replace('T3 Code', 'SpecWithCode');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-fixture-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  put(reviewedPath, oldRecording);
  put('app/fixtures/unchanged.ndjson', '{"request":"untouched"}\n');
  put('app/fixtures/run.sh', '#!/bin/sh\nexit 0\n');
  put('.repos/reference.txt', 'unchanged upstream reference\n');
  put('.gitignore', 'ignored.*\n');
  chmodSync(join(root, 'app/fixtures/run.sh'), 0o755);
  git(['init', '-q']); git(['add', '.']);
  const baseline = readProtectedBaseline(root, git(['write-tree']));
  put(reviewedPath, reviewedRecording);
  const approvals = [{ path: reviewedPath, upstreamSha256: sha(oldRecording), reviewedSha256: sha(reviewedRecording), upstreamMode: '100644', reviewedMode: '100644' }];
  return { root, put, git, baseline, approvals, run: () => verifyFixtureTree(root, baseline, approvals) };
}

test('approved bytes/modes pass while references and every unlisted fixture remain exact', t => {
  assert.deepEqual(fixture(t).run(), { referenceEntriesPreserved: 1, referenceGitlinksPreserved: 0,
    unlistedFixtureFilesPreserved: 2, reviewedFixtureMigrationsVerified: 1,
    reviewedFixtureBytesAndModesVerified: true, unlistedProtectedChangesRejected: true });
});
test('altered user prose is rejected even inside an approved recording', t => {
  const f = fixture(t); f.put(reviewedPath, reviewedRecording.replace('exact user prose', 'different task'));
  assert.throws(f.run, /Reviewed fixture bytes changed/);
});
test('arbitrary metadata is rejected even inside an approved recording', t => {
  const f = fixture(t); f.put(reviewedPath, reviewedRecording.replace('message-7', 'message-8'));
  assert.throws(f.run, /Reviewed fixture bytes changed/);
});
test('unlisted fixture content is rejected', t => {
  const f = fixture(t); f.put('app/fixtures/unchanged.ndjson', '{"request":"edited"}\n');
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test('reference content is rejected', t => {
  const f = fixture(t); f.put('.repos/reference.txt', 'edited\n');
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
for (const kind of ['tracked', 'untracked', 'ignored']) test(`${kind} new protected files are rejected`, t => {
  const f = fixture(t); const path = `app/fixtures/${kind === 'ignored' ? 'ignored.ndjson' : 'new.ndjson'}`;
  f.put(path, 'not reviewed\n'); if (kind === 'tracked') f.git(['add', path]);
  assert.throws(f.run, /Unlisted protected file/);
});
test('a new fixture tree outside existing protected roots is rejected', t => {
  const f = fixture(t); f.put('new-app/replays/new.ndjson', 'not reviewed\n');
  assert.throws(f.run, /Unlisted protected file/);
});
test('an ignored new reference file is rejected', t => {
  const f = fixture(t); f.put('.repos/ignored.txt', 'not reviewed\n');
  assert.throws(f.run, /Unlisted protected file/);
});
test('assume-unchanged cannot hide edited fixture bytes', t => {
  const f = fixture(t); f.git(['update-index', '--assume-unchanged', 'app/fixtures/unchanged.ndjson']);
  f.put('app/fixtures/unchanged.ndjson', 'edited\n'); assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test('deletion of an approved recording is rejected', t => {
  const f = fixture(t); rmSync(join(f.root, reviewedPath)); assert.throws(f.run, /ENOENT/);
});
test('an approved file cannot be replaced by a same-content symlink', t => {
  const f = fixture(t); f.put('same-content.ndjson', reviewedRecording); rmSync(join(f.root, reviewedPath));
  symlinkSync('../../same-content.ndjson', join(f.root, reviewedPath)); assert.throws(f.run, /mode\/type changed/);
});
test('a protected parent cannot be substituted with a directory symlink', t => {
  const f = fixture(t); renameSync(join(f.root, 'app/fixtures'), join(f.root, 'saved-fixtures'));
  symlinkSync('../saved-fixtures', join(f.root, 'app/fixtures')); assert.throws(f.run, /not a real directory/);
});
test('an approved file executable-mode substitution is rejected', t => {
  const f = fixture(t); chmodSync(join(f.root, reviewedPath), 0o755); assert.throws(f.run, /mode\/type changed/);
});
test('an unlisted executable-mode substitution is rejected', t => {
  const f = fixture(t); chmodSync(join(f.root, 'app/fixtures/run.sh'), 0o644); assert.throws(f.run, /mode\/type changed/);
});
test('an incorrect baseline hash is rejected', t => {
  const f = fixture(t); f.approvals[0].upstreamSha256 = '0'.repeat(64); assert.throws(f.run, /Wrong baseline bytes/);
});
test('an incorrect baseline mode is rejected', t => {
  const f = fixture(t); f.approvals[0].upstreamMode = '100755'; assert.throws(f.run, /Wrong baseline mode/);
});
test('a missing approval rejects the changed fixture', t => {
  const f = fixture(t); f.approvals.length = 0; assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test('a fabricated approval cannot add a file absent from the baseline', t => {
  const f = fixture(t); f.approvals.push({ ...f.approvals[0], path: 'app/fixtures/unknown.ndjson' });
  assert.throws(f.run, /absent from baseline/);
});
test('duplicate approvals are rejected', t => {
  const f = fixture(t); f.approvals.push({ ...f.approvals[0] }); assert.throws(f.run, /Duplicate fixture migration/);
});
for (const path of ['../app/fixtures/reviewed.ndjson', '/app/fixtures/reviewed.ndjson', 'app/fixtures/../reviewed.ndjson', 'app\\fixtures\\reviewed.ndjson', 'app//fixtures/reviewed.ndjson']) {
  test(`noncanonical approval path is rejected: ${path}`, t => {
    const f = fixture(t); f.approvals[0].path = path; assert.throws(f.run, /Noncanonical protected path/);
    const m = structuredClone(pinnedManifest); m.entries[0].path = path;
    assert.throws(() => validateFixtureManifest(m), /Noncanonical protected path/);
  });
}
test('references cannot be added to the approval list', t => {
  const f = fixture(t); f.approvals[0].path = '.repos/reference.txt'; assert.throws(f.run, /Ineligible migration path/);
});
test('the committed 80-file manifest matches its independent digest', () => {
  assert.equal(sha(pinnedBytes), FIXTURE_MANIFEST_SHA256);
  assert.equal(loadReviewedFixtureManifest(sourceRoot).entries.length, 80);
});
for (const mutation of ['missing', 'extra', 'hash', 'baseline', 'review', 'reason']) test(`the production loader rejects a ${mutation} manifest edit`, t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-manifest-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = structuredClone(pinnedManifest);
  if (mutation === 'missing') m.entries.pop();
  if (mutation === 'extra') m.entries.push({ ...m.entries[0], path: 'app/fixtures/extra.ndjson' });
  if (mutation === 'hash') m.entries[0].reviewedSha256 = sha('arbitrary replacement bytes');
  if (mutation === 'baseline') m.upstreamCommit = '0'.repeat(40);
  if (mutation === 'review') m.entries[0].reviewCommit = '0'.repeat(40);
  if (mutation === 'reason') m.entries[0].reason = 'allow arbitrary changes';
  mkdirSync(dirname(join(root, manifestPath)), { recursive: true }); writeFileSync(join(root, manifestPath), JSON.stringify(m));
  assert.throws(() => loadReviewedFixtureManifest(root), /pinned digest/);
});
test('manifest schema independently rejects missing entries and the wrong baseline', () => {
  const missing = structuredClone(pinnedManifest); missing.entries.pop();
  assert.throws(() => validateFixtureManifest(missing), /exactly 80/);
  const wrong = structuredClone(pinnedManifest); wrong.upstreamCommit = '0'.repeat(40);
  assert.throws(() => validateFixtureManifest(wrong), /Wrong fixture baseline/);
});
