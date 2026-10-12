import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Identity replacements must never alter registry hashes, encoded bytes or
// public keys. The separate fixture-preservation audit permits only exact,
// independently reviewed fixture migrations pinned by byte hashes and modes.
export function verifyPreservedLock(originalLock, currentLock, serverManifest) {
  let expectedLock = originalLock
    .replaceAll("@t3tools/", "@specweave-studio/")
    .replace("  oxlint-plugin-t3code:\n", "  oxlint-plugin-studio:\n")
    .replace("      effect-acp:", "      '@specweave-studio/effect-acp':")
    .replace(
      "      effect-codex-app-server:",
      "      '@specweave-studio/effect-codex-app-server':",
    );
  for (const name of ["markdown-text", "review-diff", "terminal"]) {
    expectedLock = expectedLock.replaceAll(`/modules/t3-${name}`, `/modules/studio-${name}`);
  }

  // Project MCP connections use the already pinned SDK at runtime. Move only
  // this exact importer record; registry packages, snapshots and every other
  // byte still have to equal the identity-mapped upstream lock.
  const sdk = "@modelcontextprotocol/sdk";
  const entry =
    "      '@modelcontextprotocol/sdk':\n        specifier: 1.29.0\n        version: 1.29.0(zod@4.6.5)\n";
  const matches = [...expectedLock.matchAll(/^  apps\/server:\n(?:(?: {4}[^\n]*)?\n)+/gm)];
  assert.equal(matches.length, 1, "Expected exactly one pinned server importer");
  const importer = matches[0][0];
  const runtimeHeader = "    dependencies:\n";
  const developmentHeader = "    devDependencies:\n";
  assert.equal(
    importer.split(runtimeHeader).length,
    2,
    "Expected one server runtime dependency section",
  );
  assert.equal(
    importer.split(developmentHeader).length,
    2,
    "Expected one server development dependency section",
  );
  assert.equal(
    importer.split(`      '${sdk}':\n`).length,
    2,
    "Expected one pinned server MCP SDK record",
  );
  assert.ok(
    importer.indexOf(entry) > importer.indexOf(developmentHeader),
    "Pinned SDK version/resolution or development placement changed",
  );
  const promoted = importer.replace(entry, "").replace(runtimeHeader, runtimeHeader + entry);
  expectedLock =
    expectedLock.slice(0, matches[0].index) +
    promoted +
    expectedLock.slice(matches[0].index + importer.length);
  assert.equal(
    serverManifest.dependencies?.[sdk],
    "1.29.0",
    "Server runtime SDK must retain its pinned version",
  );
  assert.ok(
    !Object.hasOwn(serverManifest.devDependencies ?? {}, sdk),
    "Server SDK must not remain a development dependency",
  );
  assert.equal(
    currentLock,
    expectedLock,
    "Pinned lock data may change only through the identity map and exact server MCP SDK runtime promotion",
  );
}

export function auditPreservedPayloads(root, upstream) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const originalLock = git(["show", `${upstream}:pnpm-lock.yaml`]);
  verifyPreservedLock(
    originalLock,
    readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    JSON.parse(readFileSync(join(root, "apps/server/package.json"), "utf8")),
  );

  const paths = git(["ls-tree", "-r", "--name-only", upstream]).trim().split("\n");
  const patchPaths = paths.filter((p) => p.startsWith("patches/"));
  for (const p of patchPaths) {
    assert.equal(
      readFileSync(join(root, p), "utf8"),
      git(["show", `${upstream}:${p}`]),
      `Inherited patch payload changed: ${p}`,
    );
  }

  const renames = new Map();
  for (const line of git(["diff", "--name-status", "-M20%", upstream, "--"]).trim().split("\n")) {
    const [kind, before, after] = line.split("\t");
    if (kind?.startsWith("R")) renames.set(before, after);
  }
  const selected = paths.filter(
    (p) =>
      !p.startsWith(".repos/") &&
      /\.(?:tsx?|[cm]?js|svg|astro|json|ya?ml|toml|md|swift|kt|xml|plist|sh|py|txt|lock)$/.test(p),
  );
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: selected.map((p) => `${upstream}:${p}\n`).join(""),
    maxBuffer: 128 * 1024 * 1024,
  });
  // These first-party installer illustrations were deliberately replaced with
  // owned vectors. Neither replacement may contain an encoded image.
  const ownedVectors = new Set([
    "apps/desktop/resources/dmg/dmg-background-latest.svg",
    "apps/desktop/resources/dmg/dmg-background-nightly.svg",
  ]);
  // Encoded payloads that left the tree together with the upstream artwork
  // around them. Each is named by file and exact bytes, so nothing else in
  // that file can be dropped under the same allowance.
  const removedWithUpstreamArtwork = new Map([
    // The 1x1 transparent GIF that stood in for the upstream desktop
    // screenshot on narrow screens; the screenshot and its markup are gone.
    [
      "apps/marketing/src/pages/index.astro",
      ["R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
    ],
  ]);
  const patterns = [
    /(?<=base64,)[A-Za-z0-9+/=]{40,}/g,
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    /sha(?:256|384|512)-[A-Za-z0-9+/=]{32,}/g,
    /(?<=["'])[A-Za-z0-9+/]{40,}={1,2}(?=["'])/g,
    /(?<=["'])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?=["'])/g,
  ];
  let offset = 0,
    payloads = 0,
    files = 0;
  for (const oldPath of selected) {
    const end = batch.indexOf(10, offset);
    const header = batch.subarray(offset, end).toString("utf8");
    const match = / blob (\d+)$/.exec(header);
    assert.ok(match, `Cannot inspect pinned source object: ${oldPath}`);
    const size = Number(match[1]);
    const content = batch.subarray(end + 1, end + 1 + size);
    offset = end + 1 + size + 1;
    if (content.includes(0)) continue;
    const before = content.toString("utf8");
    const payloadSet = new Set(
      patterns.flatMap((pattern) => [...before.matchAll(pattern)].map((m) => m[0])),
    );
    if (payloadSet.size === 0) continue;
    const currentPath = renames.get(oldPath) ?? oldPath;
    assert.ok(existsSync(join(root, currentPath)), `Encoded payload source missing: ${oldPath}`);
    const current = readFileSync(join(root, currentPath), "utf8");
    if (ownedVectors.has(currentPath)) {
      assert.doesNotMatch(current, /base64,|M33\.4509/);
      assert.match(current, /M349\.8 185\.5/);
      continue;
    }
    const removed = removedWithUpstreamArtwork.get(currentPath) ?? [];
    let preserved = 0;
    for (const payload of payloadSet) {
      if (!current.includes(payload) && removed.includes(payload)) continue;
      assert.ok(current.includes(payload), `Pinned encoded payload changed: ${currentPath}`);
      preserved += 1;
    }
    if (preserved === 0) continue;
    payloads += preserved;
    files += 1;
  }
  return {
    registryIntegrityRecords: (originalLock.match(/integrity:/g) ?? []).length,
    inheritedPatches: patchPaths.length,
    encodedPayloads: payloads,
    encodedPayloadFiles: files,
  };
}
