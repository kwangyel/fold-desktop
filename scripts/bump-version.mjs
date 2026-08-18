#!/usr/bin/env node
// Bump the app version in the three files that must stay in sync:
//   package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml
// (Cargo.lock is refreshed automatically by the next cargo build.)
//
// Usage: node scripts/bump-version.mjs <semver>   e.g. 0.2.0
//
// After bumping: commit, `git tag vX.Y.Z`, and push the tag to trigger
// .github/workflows/release.yml. For a security release, also raise
// .github/minimum-supported-version.txt to force older builds to update.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!version || !SEMVER.test(version)) {
  console.error("Usage: node scripts/bump-version.mjs <semver>  (e.g. 0.2.0)");
  process.exit(1);
}

// package.json
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// src-tauri/tauri.conf.json
const confPath = join(root, "src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// src-tauri/Cargo.toml — only the top-level [package] version starts a line
// with `version = "..."`; dependency versions are inline (`{ version = ... }`).
const cargoPath = join(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
if (!/^version = "[^"]*"/m.test(cargo)) {
  console.error("Could not find a top-level `version = \"...\"` in Cargo.toml");
  process.exit(1);
}
writeFileSync(
  cargoPath,
  cargo.replace(/^version = "[^"]*"/m, `version = "${version}"`),
);

console.log(`Version set to ${version} in package.json, tauri.conf.json, Cargo.toml`);
console.log(`Next: git commit, then \`git tag v${version} && git push --tags\``);
