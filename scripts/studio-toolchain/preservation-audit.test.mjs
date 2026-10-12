import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyPreservedLock } from './preservation-audit.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const upstream = '10f39eb9ac80c9a4b7f5097575dd2addc3b6f631';
const original = execFileSync('git', ['show', `${upstream}:pnpm-lock.yaml`], { cwd: root, encoding: 'utf8' });
const prior = execFileSync('git', ['show', 'f0b6d13fb273ae3285861878c43b822731926023:pnpm-lock.yaml'], { cwd: root, encoding: 'utf8' });
const current = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'apps/server/package.json'), 'utf8'));
const entry = "      '@modelcontextprotocol/sdk':\n        specifier: 1.29.0\n        version: 1.29.0(zod@4.6.5)\n";
const runtimeHeader = '  apps/server:\n    dependencies:\n';

function change(value, before, after) {
  assert.ok(value.includes(before), 'Mutation must affect an existing byte sequence');
  const result = value.replace(before, after);
  assert.notEqual(result, value);
  return result;
}
function refused(lock) {
  assert.throws(() => verifyPreservedLock(original, lock, manifest), /Pinned lock data/);
}

test('accepts the actual exact server runtime promotion and unchanged pinned registry', () => {
  verifyPreservedLock(original, current, manifest);
  assert.deepEqual(current.match(/integrity: .+/g), original.match(/integrity: .+/g));
  assert.equal(current.slice(current.indexOf('\npackages:\n')), prior.slice(prior.indexOf('\npackages:\n')));
});

for (const [name, mutate] of [
  ['SDK requested version', s => change(s, entry, entry.replace('specifier: 1.29.0', 'specifier: ^1.29.0'))],
  ['SDK resolved version', s => change(s, entry, entry.replace('version: 1.29.0', 'version: 1.30.0'))],
  ['SDK peer resolution', s => change(s, entry, entry.replace('zod@4.6.5', 'zod@4.6.6'))],
  ['registry integrity', s => change(s, 'integrity: sha512-', 'integrity: sha512-altered')],
  ['other importer dependency', s => change(s, 'version: 4.0.1', 'version: 4.0.2')],
  ['extra importer', s => change(s, 'importers:\n', 'importers:\n\n  unreviewed:\n    dependencies: {}\n')],
  ['extra registry data', s => s + '\nunreviewed: true\n'],
  ['omitted SDK runtime record', s => change(s, runtimeHeader + entry, runtimeHeader)],
  ['duplicate SDK runtime record', s => change(s, runtimeHeader + entry, runtimeHeader + entry + entry)],
  ['SDK promotion to a different importer', s => change(change(s, runtimeHeader + entry, runtimeHeader), '  apps/web:\n    dependencies:\n', '  apps/web:\n    dependencies:\n' + entry)],
]) test(`rejects changed ${name}`, () => refused(mutate(current)));

test('rejects retaining the SDK in server devDependencies, even with the runtime copy', () => {
  const start = current.indexOf(runtimeHeader);
  const dev = current.indexOf('    devDependencies:\n', start) + '    devDependencies:\n'.length;
  refused(current.slice(0, dev) + entry + current.slice(dev));
  const unpromoted = current.slice(0, dev) + entry + current.slice(dev);
  refused(change(unpromoted, runtimeHeader + entry, runtimeHeader));
});

test('rejects a baseline whose SDK version or original section changed', () => {
  const version = change(original, entry, entry.replace('specifier: 1.29.0', 'specifier: ^1.29.0'));
  assert.throws(() => verifyPreservedLock(version, current, manifest), /Pinned SDK version\/resolution or development placement changed/);
  const moved = change(change(original, entry, ''), runtimeHeader, runtimeHeader + entry);
  assert.throws(() => verifyPreservedLock(moved, current, manifest), /development placement changed/);
});

test('rejects duplicate baseline server sections or SDK records', () => {
  assert.throws(() => verifyPreservedLock(original + '\n' + runtimeHeader + entry, current, manifest), /exactly one pinned server importer/);
  assert.throws(() => verifyPreservedLock(change(original, entry, entry + entry), current, manifest), /one pinned server MCP SDK record/);
});

for (const version of [undefined, '^1.29.0', '1.30.0']) {
  test(`rejects server manifest runtime version ${version}`, () => {
    const changed = structuredClone(manifest);
    changed.dependencies['@modelcontextprotocol/sdk'] = version;
    assert.throws(() => verifyPreservedLock(original, current, changed), /retain its pinned version/);
  });
}
test('rejects a duplicate server manifest development entry', () => {
  const changed = structuredClone(manifest);
  changed.devDependencies['@modelcontextprotocol/sdk'] = '1.29.0';
  assert.throws(() => verifyPreservedLock(original, current, changed), /must not remain a development dependency/);
});
