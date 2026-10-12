import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FIXTURE_UPSTREAM = '10f39eb9ac80c9a4b7f5097575dd2addc3b6f631';
export const FIXTURE_REVIEW_COMMITS = Object.freeze([
  '0b3c7c92330742fa17ed4fdfaa211c56df4ef58c',
  'e400f67aed5d5e34a9010298983e32a0ae2cb157',
]);
// A manifest edit is not an approval. This digest pins the independently reviewed
// closed set, including paths, both byte hashes/modes, reasons and review commits.
// The original review branches need not be fetched after their cherry-picks.
export const FIXTURE_MANIFEST_SHA256 = 'b15b46ffa5f83937e5879a57e4618c966b62c5cfd74599d155e81028c46f5e19';
const MANIFEST_PATH = 'scripts/studio-toolchain/reviewed-fixture-migrations.json';
const FIXTURE_DIRECTORIES = new Set(['fixtures', '__fixtures__', 'replays']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const git = (root, args, encoding = 'utf8') => execFileSync('git', args, {
  cwd: root, encoding, maxBuffer: 128 * 1024 * 1024,
});
export const isProtectedPath = path => path.startsWith('.repos/') || path.split('/').some(part => FIXTURE_DIRECTORIES.has(part));

function canonicalPath(path) {
  assert.equal(typeof path, 'string', 'Manifest path must be a string');
  assert.ok(path.length > 0 && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), `Noncanonical protected path: ${path}`);
}

// Kept separate so path/schema rejection can be tested without changing the
// production digest. Production always loads through the pinned loader below.
export function validateFixtureManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported fixture manifest version');
  assert.equal(manifest.upstreamCommit, FIXTURE_UPSTREAM, 'Wrong fixture baseline commit');
  assert.deepEqual(manifest.reviewCommits, FIXTURE_REVIEW_COMMITS, 'Wrong fixture review commits');
  assert.equal(manifest.entries.length, 80, 'The reviewed fixture set must contain exactly 80 entries');
  const seen = new Set();
  for (const entry of manifest.entries) {
    canonicalPath(entry.path);
    assert.ok(isProtectedPath(entry.path) && !entry.path.startsWith('.repos/'), `Ineligible migration path: ${entry.path}`);
    assert.ok(!seen.has(entry.path), `Duplicate fixture migration: ${entry.path}`);
    seen.add(entry.path);
    for (const key of ['upstreamSha256', 'reviewedSha256']) assert.match(entry[key], /^[a-f0-9]{64}$/, `Invalid ${key}: ${entry.path}`);
    for (const key of ['upstreamMode', 'reviewedMode']) assert.ok(['100644', '100755'].includes(entry[key]), `Invalid ${key}: ${entry.path}`);
    assert.ok(FIXTURE_REVIEW_COMMITS.includes(entry.reviewCommit), `Unknown review commit: ${entry.path}`);
    const reason = entry.path.endsWith('/fixtures/shared.ts') || entry.path.endsWith('/fixtures/index.ts') ? 'type-import'
      : entry.path.endsWith('/fixtures/opencode2_inbox/output.ts') ? 'strict-regex-product-identity'
      : entry.path.endsWith('.ndjson') ? 'product-identity-metadata' : null;
    assert.ok(reason, `Unknown migration file: ${entry.path}`);
    assert.equal(entry.reason, reason, `Wrong migration reason: ${entry.path}`);
  }
  return manifest;
}

export function loadReviewedFixtureManifest(root) {
  const bytes = readFileSync(join(root, MANIFEST_PATH));
  assert.equal(sha256(bytes), FIXTURE_MANIFEST_SHA256, 'Reviewed fixture manifest differs from its pinned digest');
  return validateFixtureManifest(JSON.parse(bytes.toString('utf8')));
}

export function readProtectedBaseline(root, upstream) {
  const entries = new Map();
  for (const row of git(root, ['ls-tree', '-r', '-z', upstream]).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, type, object] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    if (!isProtectedPath(path)) continue;
    canonicalPath(path);
    assert.match(object, /^[a-f0-9]{40}$/, `Unexpected baseline object format: ${path}`);
    entries.set(path, { mode, type, object });
  }
  return entries;
}

function protectedRoot(path) {
  const parts = path.split('/');
  const index = parts[0] === '.repos' ? 0 : parts.findIndex(part => FIXTURE_DIRECTORIES.has(part));
  return parts.slice(0, index + 1).join('/');
}

// The caller supplies already pinned approvals; production has no configurable
// baseline, manifest, or approval override. Tests exercise this byte guard with
// tiny local Git repositories rather than editing production fixture trees.
export function verifyFixtureTree(root, baseline, approvals) {
  const approved = new Map();
  for (const entry of approvals) {
    canonicalPath(entry.path);
    assert.ok(!entry.path.startsWith('.repos/') && isProtectedPath(entry.path), `Ineligible migration path: ${entry.path}`);
    assert.ok(!approved.has(entry.path), `Duplicate fixture migration: ${entry.path}`);
    const before = baseline.get(entry.path);
    assert.ok(before, `Reviewed fixture absent from baseline: ${entry.path}`);
    assert.equal(before.type, 'blob', `Reviewed fixture is not a baseline blob: ${entry.path}`);
    assert.equal(before.mode, entry.upstreamMode, `Wrong baseline mode: ${entry.path}`);
    const bytes = git(root, ['cat-file', 'blob', before.object], null);
    assert.equal(sha256(bytes), entry.upstreamSha256, `Wrong baseline bytes: ${entry.path}`);
    assert.notEqual(entry.upstreamSha256, entry.reviewedSha256, `Redundant fixture approval: ${entry.path}`);
    approved.set(entry.path, entry);
  }

  const checkedDirectories = new Set();
  function checkedStat(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (checkedDirectories.has(parent)) continue;
      const stat = lstatSync(join(root, parent));
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Protected parent is not a real directory: ${parent}`);
      checkedDirectories.add(parent);
    }
    return lstatSync(join(root, path));
  }

  let references = 0, unchangedFixtures = 0, gitlinks = 0;
  for (const [path, before] of baseline) {
    const absolute = join(root, path);
    const stat = checkedStat(path); // Missing files fail, even with assume-unchanged flags.
    if (before.mode === '160000') {
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Reference gitlink substituted: ${path}`);
      assert.equal(git(root, ['ls-files', '--stage', '--', path]).split('\t')[0], `160000 ${before.object} 0`, `Reference gitlink changed: ${path}`);
      if (readdirSync(absolute).length > 0) {
        assert.equal(resolve(git(absolute, ['rev-parse', '--show-toplevel']).trim()), resolve(absolute), `Reference gitlink is not its own checkout: ${path}`);
        assert.equal(git(absolute, ['rev-parse', 'HEAD']).trim(), before.object, `Reference gitlink HEAD changed: ${path}`);
        assert.equal(git(absolute, ['status', '--porcelain', '--untracked-files=all']).trim(), '', `Reference gitlink contains edits: ${path}`);
      }
      gitlinks++;
    } else {
      const mode = stat.isSymbolicLink() ? '120000' : stat.isFile() ? (stat.mode & 0o111 ? '100755' : '100644') : 'unsupported';
      const approval = approved.get(path);
      assert.equal(mode, approval?.reviewedMode ?? before.mode, `Protected file mode/type changed: ${path}`);
      const bytes = mode === '120000' ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
      if (approval) assert.equal(sha256(bytes), approval.reviewedSha256, `Reviewed fixture bytes changed: ${path}`);
      else assert.equal(gitBlobHash(bytes), before.object, `Unreviewed protected bytes changed: ${path}`);
    }
    if (path.startsWith('.repos/')) references++;
    else if (!approved.has(path)) unchangedFixtures++;
  }

  // Git finds new fixture trees; walking existing protected trees additionally
  // rejects ignored files and symlinks that Git's normal status would omit.
  const currentPaths = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const path of currentPaths) {
    if (isProtectedPath(path)) assert.ok(baseline.has(path), `Unlisted protected file: ${path}`);
  }
  const roots = [...new Set([...baseline.keys()].map(protectedRoot))].sort();
  function walk(path) {
    if (baseline.get(path)?.mode === '160000') return;
    const stat = checkedStat(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of readdirSync(join(root, path))) walk(`${path}/${name}`);
    } else assert.ok(baseline.has(path), `Unlisted protected file: ${path}`);
  }
  for (const path of roots) walk(path);
  return { referenceEntriesPreserved: references, referenceGitlinksPreserved: gitlinks,
    unlistedFixtureFilesPreserved: unchangedFixtures, reviewedFixtureMigrationsVerified: approved.size,
    reviewedFixtureBytesAndModesVerified: true, unlistedProtectedChangesRejected: true };
}

export function auditPreservedFixtures(root, upstream) {
  assert.equal(upstream, FIXTURE_UPSTREAM, 'Fixture audit must use the pinned upstream baseline');
  const manifest = loadReviewedFixtureManifest(root);
  const result = verifyFixtureTree(root, readProtectedBaseline(root, upstream), manifest.entries);
  return { ...result, upstreamCommit: upstream, reviewCommits: FIXTURE_REVIEW_COMMITS,
    manifestSha256: FIXTURE_MANIFEST_SHA256 };
}
