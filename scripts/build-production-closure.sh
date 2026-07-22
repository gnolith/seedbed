#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 5 || $# -gt 6 ]]; then
  echo "usage: $0 SEEDBED_TGZ SEEDBED_INTEGRITY DIAMOND_TGZ TAPROOT_TGZ WORKSHOP_TGZ [OUTPUT]" >&2
  exit 2
fi

repository=$(cd "$(dirname "$0")/.." && pwd -P)
seedbed=$(realpath "$1")
seedbed_integrity="$2"
diamond=$(realpath "$3")
taproot=$(realpath "$4")
workshop=$(realpath "$5")
output=$(realpath -m "${6:-gnolith-production-closure.tar.gz}")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
root="$work/root"
cache="$work/npm-cache"
mkdir -p "$root" "$cache"
cp "$repository/docker/package.json" "$repository/docker/package-lock.json" "$root/"

node - "$root/package.json" "$root/package-lock.json" "$repository/package.json" <<'NODE'
const fs = require('fs');
const [manifestPath, lockPath, seedbedManifestPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const seedbed = JSON.parse(fs.readFileSync(seedbedManifestPath, 'utf8'));
if (manifest.version !== seedbed.version) {
  throw new Error(`production closure version ${manifest.version} does not match Seedbed ${seedbed.version}`);
}
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (entry?.version !== version) throw new Error(`${name} is not exactly locked to ${version}`);
}
for (const [location, entry] of Object.entries(lock.packages ?? {})) {
  if (!location || entry.link) continue;
  if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
    throw new Error(`${location} has no SHA-512 integrity in the production lock`);
  }
  if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) {
    throw new Error(`${location} has a non-registry or missing resolution in the production lock`);
  }
}
NODE

# A new empty cache plus npm ci means every transitive production byte must be
# the exact integrity recorded in the committed lock. Network is allowed only
# while materializing this reviewed closure, never during the image build.
echo 'materializing the integrity-locked production cache'
npm ci --ignore-scripts --no-audit --no-fund --cache "$cache" --prefix "$root"
echo 'verifying registry signatures for the locked production graph'
npm --prefix "$root" audit signatures
audit_report="$work/production-audit.json"
set +e
npm --prefix "$root" audit --omit=dev --json > "$audit_report"
audit_status=$?
set -e
node - "$audit_report" "$audit_status" <<'NODE'
const fs = require('fs');
const [path, status] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const total = report.metadata?.vulnerabilities?.total;
if (status !== '0' || total !== 0) throw new Error(`production audit failed closed (status ${status}, total ${String(total)})`);
NODE
rm -rf "$root/node_modules"
# Prove that the fresh cache is a complete offline realization of the lock.
echo 'reinstalling the complete production graph with offline mode and an invalid registry'
npm ci --offline --registry=http://127.0.0.1:9 \
  --ignore-scripts --no-audit --no-fund --cache "$cache" --prefix "$root"

artifact_integrity() {
  node - "$1" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const artifact = process.argv[2];
process.stdout.write(`sha512-${crypto.createHash('sha512').update(fs.readFileSync(artifact)).digest('base64')}`);
NODE
}

locked_integrity() {
  node - "$root/package-lock.json" "$1" <<'NODE'
const fs = require('fs');
const [lockPath, name] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const integrity = lock.packages?.[`node_modules/${name}`]?.integrity;
if (typeof integrity !== 'string') throw new Error(`${name} has no locked integrity`);
process.stdout.write(integrity);
NODE
}

verify_locked_artifact() {
  artifact="$1"
  package="$2"
  test "$(artifact_integrity "$artifact")" = "$(locked_integrity "$package")" || {
    echo "$package artifact integrity does not match the committed production lock" >&2
    exit 1
  }
}

verify_locked_artifact "$diamond" '@gnolith/diamond'
verify_locked_artifact "$taproot" '@gnolith/taproot'
verify_locked_artifact "$workshop" '@gnolith/workshop'
test "$(artifact_integrity "$seedbed")" = "$seedbed_integrity" || {
  echo 'Seedbed artifact integrity does not match the verified publication artifact' >&2
  exit 1
}

install_exact_package() {
  artifact="$1"
  package_path="$2"
  destination="$root/node_modules/$package_path"
  rm -rf "$destination"
  mkdir -p "$destination"
  tar -xzf "$artifact" --strip-components=1 -C "$destination"
}

# Replace lock-installed top-level packages with the already independently
# verified publication artifacts so the image bytes and provenance subjects
# are the same objects.
npm --prefix "$root" ls --omit=dev --all --json > "$root/production-tree.json"
install_exact_package "$diamond" '@gnolith/diamond'
install_exact_package "$taproot" '@gnolith/taproot'
install_exact_package "$workshop" '@gnolith/workshop'
install_exact_package "$seedbed" '@gnolith/seedbed'
chmod 0755 "$root/node_modules/@gnolith/seedbed/dist/cli.js"
mkdir -p "$root/node_modules/.bin"
ln -s ../@gnolith/seedbed/dist/cli.js "$root/node_modules/.bin/seedbed"
cp "$repository/docker/package-lock.json" "$root/production-package-lock.json"
chmod 0644 "$root/production-package-lock.json" "$root/production-tree.json"

node - "$root" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const expected = {
  diamond: '0.4.1',
  taproot: '0.4.0',
  workshop: '0.4.0',
  seedbed: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
};
for (const [name, version] of Object.entries(expected)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@gnolith', name, 'package.json'), 'utf8'));
  if (manifest.name !== `@gnolith/${name}` || manifest.version !== version) {
    throw new Error(`closure contains ${manifest.name}@${manifest.version}; expected @gnolith/${name}@${version}`);
  }
}
const cli = path.join(root, 'node_modules', '@gnolith', 'seedbed', 'dist', 'cli.js');
if (!fs.statSync(cli).isFile()) throw new Error('closure omitted the Seedbed CLI');
NODE

cp "$repository/scripts/verify-production-tree.mjs" "$root/"
rm "$root/package.json" "$root/package-lock.json"
node "$root/verify-production-tree.mjs" --write "$root"

archive() {
  source="$1"
  target="$2"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    --format=posix --pax-option=delete=atime,delete=ctime \
    -cf - -C "$source" node_modules production-package-lock.json production-tree.json \
      verify-production-tree.mjs production-files.json \
    | gzip -n > "$target"
}

first="$work/closure-first.tar.gz"
second="$work/closure-second.tar.gz"
archive "$root" "$first"
roundtrip="$work/roundtrip"
mkdir "$roundtrip"
tar -xzf "$first" -C "$roundtrip"
node "$roundtrip/verify-production-tree.mjs" --verify "$roundtrip"

expect_tree_rejection() {
  if node "$roundtrip/verify-production-tree.mjs" --verify "$roundtrip" >/dev/null 2>&1; then
    echo "$1 was not rejected by the complete production-tree manifest" >&2
    exit 1
  fi
}

touch "$roundtrip/unexpected-extra-file"
expect_tree_rejection 'an extra file'
rm "$roundtrip/unexpected-extra-file"
chmod 0644 "$roundtrip/node_modules/@gnolith/seedbed/dist/cli.js"
expect_tree_rejection 'a changed executable mode'
chmod 0755 "$roundtrip/node_modules/@gnolith/seedbed/dist/cli.js"
rm "$roundtrip/node_modules/.bin/seedbed"
ln -s ../@gnolith/taproot/dist/index.js "$roundtrip/node_modules/.bin/seedbed"
expect_tree_rejection 'a changed symlink target'
rm "$roundtrip/node_modules/.bin/seedbed"
ln -s ../@gnolith/seedbed/dist/cli.js "$roundtrip/node_modules/.bin/seedbed"
node "$roundtrip/verify-production-tree.mjs" --verify "$roundtrip"

unsafe="$work/unsafe-path.tar.gz"
tar -czf "$unsafe" --transform='s|^|../|' -C "$roundtrip" verify-production-tree.mjs
if node "$roundtrip/verify-production-tree.mjs" --archive "$unsafe" >/dev/null 2>&1; then
  echo 'an unsafe archive path was accepted' >&2
  exit 1
fi
archive "$roundtrip" "$second"
cmp "$first" "$second"
mkdir -p "$(dirname "$output")"
mv "$first" "$output"
sha256sum "$output" > "$output.sha256"
echo "production closure $(sha256sum "$output" | cut -d ' ' -f 1)"
