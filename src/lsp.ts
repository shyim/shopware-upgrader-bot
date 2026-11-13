import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, tryRun } from './exec.ts';
import type { Artifact, GitHub, Release } from './github.ts';

const LSP_REPO = process.env.LSP_REPO ?? 'shopware/shopware-lsp';

export interface ResolvedLsp {
  kind: 'artifact' | 'source' | 'release';
  /** Artifact ID for `artifact`, commit SHA for `source`, tag for `release`. */
  ref: string;
  /** Cache key of the binary. */
  key: string;
}

/** Rust target triple of the binaries shopware-lsp builds for this machine. */
function targetTriple(): string {
  const triple = process.env.LSP_TARGET ?? (
    {
      'linux/x64': 'x86_64-unknown-linux-gnu',
      'linux/arm64': 'aarch64-unknown-linux-gnu',
      'darwin/x64': 'x86_64-apple-darwin',
      'darwin/arm64': 'aarch64-apple-darwin',
    } as Record<string, string>
  )[`${platform()}/${arch()}`];
  if (!triple) {
    throw new Error(`no shopware-lsp binary for ${platform()}/${arch()}`);
  }
  return triple;
}

/**
 * Pins `lsp.version` to something cacheable: a release tag, or for a
 * `source:<ref>` version the newest binary shopware-lsp's own workflows built
 * for that branch or commit (artifacts last a week). Without one, the commit
 * the ref points at, which the workflow then builds itself.
 */
export async function resolveLsp(github: GitHub, version: string): Promise<ResolvedLsp> {
  if (version.startsWith('source:')) {
    const ref = version.slice('source:'.length);
    const commit = await github.get<{ sha: string }>(
      `/repos/${LSP_REPO}/commits/${encodeURIComponent(ref)}`,
    );
    const { artifacts } = await github.get<{ artifacts: Artifact[] }>(
      `/repos/${LSP_REPO}/actions/artifacts?name=server-${targetTriple()}&per_page=100`,
    );
    const prebuilt = artifacts
      .filter(
        ({ expired, workflow_run: run }) =>
          !expired &&
          // A pull request from a fork can use any branch name and upload
          // any artifact; only runs on the repository's own branches count.
          run.head_repository_id === run.repository_id &&
          (run.head_branch === ref || run.head_sha === commit.sha),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (prebuilt) {
      return {
        kind: 'artifact',
        ref: String(prebuilt.id),
        key: `artifact-${prebuilt.workflow_run.head_sha}`,
      };
    }
    return { kind: 'source', ref: commit.sha, key: `source-${commit.sha}` };
  }

  let tag = version;
  if (version === 'latest') {
    // `/releases/latest` skips pre-releases; the list does not.
    const [release] = await github.get<Release[]>(`/repos/${LSP_REPO}/releases?per_page=1`);
    if (!release) {
      throw new Error(`${LSP_REPO} has no release`);
    }
    tag = release.tag_name;
  }
  return { kind: 'release', ref: tag, key: `release-${tag}` };
}

/** Downloads the release binary for this machine into `directory`. */
export async function downloadLsp(github: GitHub, tag: string, directory: string): Promise<string> {
  const os = ({ linux: 'linux', darwin: 'darwin' } as Record<string, string>)[platform()];
  const cpu = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[arch()];
  if (!os || !cpu) {
    throw new Error(`no release binary for ${platform()}/${arch()}`);
  }

  const name = `shopware-lsp_${tag}_${os}_${cpu}.zip`;
  const release = await github.get<Release>(
    `/repos/${LSP_REPO}/releases/tags/${encodeURIComponent(tag)}`,
  );
  const asset = (wanted: string): Promise<Buffer> => {
    const found = release.assets.find((candidate) => candidate.name === wanted);
    if (!found) {
      throw new Error(`release ${tag} has no ${wanted}`);
    }
    return github.download(found.browser_download_url);
  };

  const [archive, checksums] = await Promise.all([asset(name), asset('checksums.txt')]);
  const expected = checksums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
  const actual = createHash('sha256').update(archive).digest('hex');
  if (expected !== actual) {
    throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  }

  return unpack(archive, directory);
}

/** Downloads the binary of a workflow artifact into `directory`. Needs a token. */
export async function downloadLspArtifact(github: GitHub, id: string, directory: string): Promise<string> {
  if (!/^\d+$/.test(id)) {
    throw new Error(`invalid artifact ID ${JSON.stringify(id)}`);
  }
  return unpack(await github.getFile(`/repos/${LSP_REPO}/actions/artifacts/${id}/zip`), directory);
}

/** Extracts `shopware-lsp` from a zip archive into `directory`. */
function unpack(archive: Buffer, directory: string): string {
  const temporary = mkdtempSync(join(tmpdir(), 'shopware-lsp-'));
  try {
    const zip = join(temporary, 'shopware-lsp.zip');
    writeFileSync(zip, archive);
    mkdirSync(directory, { recursive: true });
    run('unzip', ['-oq', zip, 'shopware-lsp', '-d', directory]);
    chmodSync(join(directory, 'shopware-lsp'), 0o755);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return join(directory, 'shopware-lsp');
}

/** Returns the binary's version, and throws when it cannot `check --fix`. */
export function verifyLsp(binary: string, env?: NodeJS.ProcessEnv): string {
  const version = run(binary, ['version'], { capture: true, env });
  const help = tryRun(binary, ['check', '--help'], { capture: true, env }) ?? '';
  if (!help.includes('--fix')) {
    throw new Error(`${version} has no \`check --fix\`; point lsp.version at a build that does`);
  }
  return version;
}
