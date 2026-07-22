import { pathToFileURL } from 'node:url';

export const githubArtifactNameForbiddenCharacters = /[":<>|*?\r\n\\/]/g;

export function createGitHubArtifactName(...parts) {
  if (parts.length === 0 || parts.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error('artifact name parts must be non-empty strings');
  }
  const name = parts.join('-').replace(githubArtifactNameForbiddenCharacters, '-');
  if (name.length === 0) throw new Error('artifact name must not be empty');
  return name;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) {
    process.stderr.write('usage: github-artifact-name <prefix> <identity> <attempt>\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${createGitHubArtifactName(...process.argv.slice(2))}\n`);
  }
}
