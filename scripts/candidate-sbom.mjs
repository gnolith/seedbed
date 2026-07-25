import { createHash } from 'node:crypto';

const SOURCE_REPOSITORIES = {
  diamond: 'https://github.com/gnolith/diamond',
  taproot: 'https://github.com/gnolith/taproot',
  workshop: 'https://github.com/gnolith/workshop',
  waystone: 'https://github.com/gnolith/waystone',
};

export function createCandidateSbom(input) {
  const rootRef = purl('@gnolith/seedbed', input.packageManifest.version);
  const componentRefs = {};
  const components = [];
  for (const name of ['diamond', 'taproot', 'workshop', 'waystone']) {
    const locked = input.componentLock.packages[name];
    const shipped = input.shippedArchives[name];
    if (locked === undefined) throw new TypeError(`SBOM component lock is missing ${name}`);
    if (shipped === undefined) throw new TypeError(`SBOM shipped archive evidence is missing ${name}`);
    if (name !== 'waystone' && shipped.sha256 !== locked.sha256) {
      throw new TypeError(`SBOM shipped archive does not match the ${name} component lock`);
    }
    const packageName = `@gnolith/${name}`;
    const ref = purl(packageName, locked.version);
    componentRefs[name] = ref;
    const properties = [
      property('gnolith:artifact:path', shipped.path),
      property('gnolith:source:commit', locked.sourceCommit),
    ];
    if (name === 'waystone') {
      properties.push(
        property('gnolith:asset:format', input.waystoneManifest.format),
        property('gnolith:asset:entrypoint', input.waystoneManifest.entrypoint),
      );
      for (const file of input.waystoneManifest.files) {
        properties.push(
          property(`gnolith:asset:${file.path}:sha256`, file.sha256),
          property(`gnolith:asset:${file.path}:bytes`, String(file.bytes)),
        );
      }
    }
    components.push({
      'bom-ref': ref,
      type: 'library',
      group: '@gnolith',
      name,
      version: locked.version,
      scope: 'required',
      purl: ref,
      hashes: [hash(shipped.sha256)],
      licenses: [mitLicense()],
      properties,
      externalReferences: [{
        type: 'vcs',
        url: `${SOURCE_REPOSITORIES[name]}/tree/${locked.sourceCommit}`,
      }],
    });
  }

  const lockRef = 'urn:gnolith:seedbed:component-lock';
  const graphRef = 'urn:gnolith:seedbed:compose-graph';
  const bundleRef = 'urn:gnolith:seedbed:compose-bundle';
  const waystoneAssetsRef = 'urn:gnolith:seedbed:waystone-assets';
  components.push(
    fileComponent(waystoneAssetsRef, 'waystone-assets.json', input.componentLock.packages.waystone.sha256, [
      property('gnolith:artifact:path', input.componentLock.packages.waystone.artifact),
      property('gnolith:asset:format', input.waystoneManifest.format),
      property('gnolith:source:commit', input.componentLock.packages.waystone.sourceCommit),
    ]),
    fileComponent(lockRef, 'seedbed-component-lock.json', input.componentLockSha256, [
      property('gnolith:format', input.componentLock.format),
    ]),
    fileComponent(graphRef, 'compose-graph.json', input.graphSha256, [
      property('gnolith:source:commit', input.commit),
    ]),
    fileComponent(bundleRef, 'seedbed-compose-bundle.tar.gz', input.composeBundleSha256, [
      property('gnolith:source:commit', input.commit),
    ]),
  );

  const dependencyRefs = Object.values(componentRefs);
  const identity = createHash('sha256').update(JSON.stringify({
    commit: input.commit,
    tree: input.tree,
    packageSha256: input.packageSha256,
    composeBundleSha256: input.composeBundleSha256,
    graphSha256: input.graphSha256,
    componentLockSha256: input.componentLockSha256,
    components: input.componentLock.packages,
    shippedArchives: input.shippedArchives,
  })).digest('hex');
  const result = {
    $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: deterministicUuid(identity),
    version: 1,
    metadata: {
      timestamp: input.commitTimestamp,
      lifecycles: [{ phase: 'build' }],
      tools: [{
        vendor: 'Gnolith',
        name: 'Seedbed candidate builder',
        version: input.packageManifest.version,
      }],
      component: {
        'bom-ref': rootRef,
        type: 'application',
        group: '@gnolith',
        name: 'seedbed',
        version: input.packageManifest.version,
        scope: 'required',
        purl: rootRef,
        hashes: [hash(input.packageSha256)],
        licenses: [mitLicense()],
        properties: [
          property('gnolith:source:commit', input.commit),
          property('gnolith:source:tree', input.tree),
          property('gnolith:component-lock:sha256', input.componentLockSha256),
          property('gnolith:compose-graph:sha256', input.graphSha256),
          property('gnolith:compose-bundle:sha256', input.composeBundleSha256),
        ],
        externalReferences: [{
          type: 'vcs',
          url: `${input.packageManifest.repository.url.replace(/\.git$/u, '')}/tree/${input.commit}`,
        }],
      },
    },
    components,
    dependencies: [
      { ref: rootRef, dependsOn: [...dependencyRefs, waystoneAssetsRef, lockRef, graphRef, bundleRef].sort() },
      { ref: lockRef, dependsOn: [...dependencyRefs, waystoneAssetsRef].sort() },
      { ref: graphRef, dependsOn: [...dependencyRefs, waystoneAssetsRef, lockRef].sort() },
      { ref: bundleRef, dependsOn: [...dependencyRefs, waystoneAssetsRef, lockRef].sort() },
      { ref: waystoneAssetsRef, dependsOn: [componentRefs.waystone] },
      ...dependencyRefs.sort().map((ref) => ({ ref, dependsOn: [] })),
    ],
    compositions: [{
      aggregate: 'complete',
      assemblies: [rootRef],
      dependencies: [...dependencyRefs, waystoneAssetsRef, lockRef, graphRef, bundleRef].sort(),
    }],
  };
  assertCandidateSbom(result, input);
  return result;
}

export function assertCandidateSbom(sbom, input) {
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5') {
    throw new TypeError('Candidate SBOM must be CycloneDX 1.5');
  }
  if (sbom.compositions?.length !== 1 || sbom.compositions[0].aggregate !== 'complete') {
    throw new TypeError('Candidate SBOM must declare a complete composition');
  }
  const expected = ['diamond', 'taproot', 'workshop', 'waystone'];
  for (const name of expected) {
    const locked = input.componentLock.packages[name];
    const shipped = input.shippedArchives[name];
    const component = sbom.components.find((entry) => entry.purl === purl(`@gnolith/${name}`, locked.version));
    if (
      component === undefined
      || component.hashes?.[0]?.content !== shipped.sha256
      || component.licenses?.[0]?.license?.id !== 'MIT'
      || !component.externalReferences?.[0]?.url.endsWith(`/tree/${locked.sourceCommit}`)
    ) throw new TypeError(`Candidate SBOM does not bind complete ${name} provenance`);
  }
  const root = sbom.metadata.component;
  if (
    root.hashes?.[0]?.content !== input.packageSha256
    || !root.properties.some((entry) => entry.name === 'gnolith:source:tree' && entry.value === input.tree)
  ) throw new TypeError('Candidate SBOM does not bind package/source provenance');
  const waystoneAssets = sbom.components.find((entry) => entry['bom-ref'] === 'urn:gnolith:seedbed:waystone-assets');
  if (waystoneAssets?.hashes?.[0]?.content !== input.componentLock.packages.waystone.sha256) {
    throw new TypeError('Candidate SBOM does not bind the shipped Waystone asset manifest');
  }
  const rootDependency = sbom.dependencies.find((entry) => entry.ref === root['bom-ref']);
  if (rootDependency?.dependsOn?.length !== 8) throw new TypeError('Candidate SBOM root dependency graph is incomplete');
}

function purl(name, version) {
  return `pkg:npm/${name.replaceAll('@', '%40')}@${version}`;
}

function hash(content) {
  if (!/^[0-9a-f]{64}$/u.test(content)) throw new TypeError('SBOM SHA-256 value is not canonical');
  return { alg: 'SHA-256', content };
}

function property(name, value) {
  return { name, value };
}

function mitLicense() {
  return { license: { id: 'MIT' } };
}

function fileComponent(ref, name, digest, properties) {
  return {
    'bom-ref': ref,
    type: 'file',
    name,
    hashes: [hash(digest)],
    properties,
  };
}

function deterministicUuid(hex) {
  const value = hex.slice(0, 32).split('');
  value[12] = '5';
  value[16] = ['8', '9', 'a', 'b'][Number.parseInt(value[16], 16) % 4];
  const joined = value.join('');
  return `urn:uuid:${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
