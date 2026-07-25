import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

const PROVENANCE_PATH = 'components/waystone/provenance.json';

export async function loadWaystoneEvidence(componentLock, shippedArchives, waystoneManifest) {
  const provenanceBytes = await readFile(PROVENANCE_PATH);
  const provenance = parseJson(provenanceBytes, 'Seedbed Waystone provenance');
  const locked = componentLock.packages.waystone;
  const shipped = shippedArchives.waystone;
  if (
    provenance.format !== 'gnolith-seedbed-waystone-provenance-v1'
    || provenance.sourceCommit !== locked.sourceCommit
    || !/^[0-9a-f]{40}$/u.test(provenance.sourceTree)
  ) throw new TypeError('Waystone provenance does not match the component lock');

  const evidence = {
    provenance: await evidenceFile(PROVENANCE_PATH, provenanceBytes),
    candidate: await evidenceFile(provenance.ownerEvidence?.candidate?.path),
    inventory: await evidenceFile(provenance.ownerEvidence?.inventory?.path),
    sbom: await evidenceFile(provenance.ownerEvidence?.sbom?.path),
  };
  for (const name of ['candidate', 'inventory', 'sbom']) {
    if (evidence[name].sha256 !== provenance.ownerEvidence[name].sha256) {
      throw new TypeError(`Waystone ${name} evidence digest does not match provenance`);
    }
  }

  const packageBytes = await readFile(provenance.package?.path);
  const packageMetadata = await stat(provenance.package?.path);
  const packageSha256 = sha256(packageBytes);
  const packageIntegrity = `sha512-${createHash('sha512').update(packageBytes).digest('base64')}`;
  if (
    provenance.package.path !== shipped.path
    || packageMetadata.size !== provenance.package.bytes
    || packageSha256 !== provenance.package.sha256
    || packageSha256 !== shipped.sha256
    || packageIntegrity !== provenance.package.integrity
  ) throw new TypeError('Waystone runtime archive does not match provenance');

  const manifestBytes = await readFile(provenance.assetManifest?.path);
  const cssEntry = waystoneManifest.files?.find((entry) => entry.path === waystoneManifest.entrypoint);
  const cssBytes = await readFile(provenance.css?.path);
  if (
    provenance.assetManifest.path !== locked.artifact
    || sha256(manifestBytes) !== provenance.assetManifest.sha256
    || provenance.assetManifest.sha256 !== locked.sha256
    || provenance.css.sha256 !== cssEntry?.sha256
    || sha256(cssBytes) !== provenance.css.sha256
  ) throw new TypeError('Waystone public assets do not match provenance');

  const candidate = parseJson(await readFile(evidence.candidate.path), 'Waystone owner candidate');
  const inventory = parseJson(await readFile(evidence.inventory.path), 'Waystone owner inventory');
  const ownerSbom = parseJson(await readFile(evidence.sbom.path), 'Waystone owner SBOM');
  const workshop = componentLock.packages.workshop;
  if (
    candidate.package !== '@gnolith/waystone'
    || candidate.version !== locked.version
    || candidate.commit !== locked.sourceCommit
    || candidate.files?.['gnolith-waystone-0.3.0.tgz'] !== packageSha256
    || candidate.files?.['inventory.json'] !== evidence.inventory.sha256
    || candidate.files?.['waystone.cdx.json'] !== evidence.sbom.sha256
    || candidate.files?.['waystone-assets.json'] !== locked.sha256
    || candidate.files?.['waystone.css'] !== provenance.css.sha256
    || candidate.workshop?.commit !== workshop.sourceCommit
    || candidate.workshop?.archiveSha256 !== workshop.sha256
    || String(candidate.workshop?.schemaVersion) !== String(componentLock.migrations.workshop)
    || candidate.workshop?.catalogDigest !== componentLock.migrations.expectedCatalogDigest
  ) throw new TypeError('Waystone owner candidate is incompatible with the exact Seedbed graph');
  if (
    inventory.package !== '@gnolith/waystone'
    || inventory.version !== locked.version
    || inventory.commit !== locked.sourceCommit
    || inventory.operationCatalogDigest !== componentLock.migrations.expectedCatalogDigest
  ) throw new TypeError('Waystone owner inventory is incompatible with the exact Seedbed graph');
  if (
    ownerSbom.bomFormat !== 'CycloneDX'
    || ownerSbom.specVersion !== '1.6'
    || ownerSbom.metadata?.component?.name !== '@gnolith/waystone'
    || ownerSbom.metadata?.component?.version !== locked.version
  ) throw new TypeError('Waystone owner SBOM identity is invalid');

  return Object.freeze({
    format: provenance.format,
    sourceCommit: provenance.sourceCommit,
    sourceTree: provenance.sourceTree,
    package: Object.freeze({
      path: provenance.package.path,
      bytes: provenance.package.bytes,
      sha256: packageSha256,
      integrity: packageIntegrity,
    }),
    assetManifest: Object.freeze({ path: locked.artifact, sha256: locked.sha256 }),
    css: Object.freeze({ path: provenance.css.path, sha256: provenance.css.sha256 }),
    ownerEvidence: Object.freeze({
      candidate: Object.freeze(evidence.candidate),
      inventory: Object.freeze(evidence.inventory),
      sbom: Object.freeze(evidence.sbom),
    }),
    provenance: Object.freeze(evidence.provenance),
  });
}

async function evidenceFile(path, bytes = undefined) {
  if (typeof path !== 'string') throw new TypeError('Waystone evidence path is absent');
  const value = bytes ?? await readFile(path);
  return Object.freeze({ path, sha256: sha256(value) });
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
