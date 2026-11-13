import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Target } from './config.ts';
import { run, tryRun, type RunOptions } from './exec.ts';
import type { GitHub, PullRequest } from './github.ts';
import { verifyLsp } from './lsp.ts';

const SUMMARY_LIMIT = 4000;

export interface UpgradeOptions {
  github: GitHub;
  /** Token that clones and pushes; the same one `github` uses. */
  token: string;
  lspBin: string;
  /** Fix and report, but do not push or touch pull requests. */
  dryRun?: boolean;
}

/**
 * Clones one repository, applies `shopware-lsp check --fix`, and keeps a pull
 * request with the result up to date. Returns a one-line outcome.
 */
export async function upgradeRepository(
  target: Target,
  { github, token, lspBin, dryRun = false }: UpgradeOptions,
): Promise<string> {
  const { repo } = target;
  const lspVersion = verifyLsp(lspBin);

  // The token reaches git only, and only for github.com; composer and the
  // language server run without it.
  const { BOT_GITHUB_TOKEN: _token, ...env } = process.env;
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credentials}`,
  };

  const base =
    target.branch || (await github.get<{ default_branch: string }>(`/repos/${repo}`)).default_branch;
  const work = mkdtempSync(join(tmpdir(), 'upgrader-'));
  const clone = join(work, 'repo');
  const git = (args: string[], options: RunOptions = {}) =>
    run('git', args, { cwd: clone, env, ...options });
  const gitSucceeds = (args: string[], options: RunOptions = {}) =>
    tryRun('git', args, { cwd: clone, env, capture: true, ...options }) !== null;

  try {
    console.log(`==> ${repo}: cloning ${base}`);
    run('git', ['clone', '--depth', '1', '--branch', base, `https://github.com/${repo}.git`, clone], {
      env: gitEnv,
    });

    if (target.composer_install && existsSync(join(clone, 'composer.json'))) {
      console.log(`==> ${repo}: composer install`);
      run(
        'composer',
        ['install', '--no-interaction', '--no-progress', '--no-scripts', '--no-plugins', '--ignore-platform-reqs'],
        { cwd: clone, env },
      );
    }

    console.log(`==> ${repo}: ${lspVersion} check --fix`);
    const summary = check(target, { lspBin, clone, work, env });

    git(['add', '--update', '--', ...target.paths]);
    const changed = !gitSucceeds(['diff', '--cached', '--quiet']);
    const head = `${repo.split('/')[0]}:${target.pr_branch}`;
    const pulls = (state: 'open' | 'all') =>
      github.get<PullRequest[]>(`/repos/${repo}/pulls?state=${state}&head=${encodeURIComponent(head)}`);

    if (dryRun) {
      if (changed) {
        git(['diff', '--cached', '--stat']);
      }
      return report(repo, changed ? 'dry run: would open or update a pull request' : 'dry run: nothing to fix');
    }

    if (!changed) {
      // Nothing left to fix on the base branch, so an open pull request is obsolete.
      const [obsolete] = await pulls('open');
      if (!obsolete) {
        return report(repo, 'nothing to fix');
      }
      await github.post(`/repos/${repo}/issues/${obsolete.number}/comments`, {
        body: `Nothing is left to fix on \`${base}\`, closing.`,
      });
      await github.patch(`/repos/${repo}/pulls/${obsolete.number}`, { state: 'closed' });
      await github.delete(`/repos/${repo}/git/refs/heads/${target.pr_branch}`);
      return report(repo, `nothing to fix, closed ${obsolete.html_url}`);
    }

    const user = await github.get<{ login: string; id: number }>('/user');
    const name = process.env.BOT_GIT_NAME ?? user.login;
    const email = process.env.BOT_GIT_EMAIL ?? `${user.id}+${user.login}@users.noreply.github.com`;
    git([
      '-c', `user.name=${name}`,
      '-c', `user.email=${email}`,
      'commit', '--quiet', '--message', target.commit_message,
    ]);

    // Push only when the result differs from what the branch already holds, so
    // an unchanged run does not retrigger the target's CI.
    const ref = `refs/heads/${target.pr_branch}`;
    const upToDate =
      gitSucceeds(['fetch', '--quiet', '--depth', '1', 'origin', ref], { env: gitEnv }) &&
      gitSucceeds(['diff', '--quiet', 'FETCH_HEAD', 'HEAD']);
    if (!upToDate) {
      git(['push', '--quiet', '--force', 'origin', `HEAD:${ref}`], { env: gitEnv });
    }

    const body = pullRequestBody(target, { base, lspVersion, summary });
    const [open] = await pulls('open');
    if (open) {
      if (!upToDate) {
        await github.patch(`/repos/${repo}/pulls/${open.number}`, { body });
      }
      return report(repo, `${upToDate ? 'unchanged' : 'updated'} ${open.html_url}`);
    }
    if (upToDate && (await pulls('all')).length > 0) {
      // Same fixes as a pull request somebody closed: do not reopen it.
      return report(repo, 'the same fixes were closed before, skipped');
    }

    const created = await github.post<PullRequest>(`/repos/${repo}/pulls`, {
      title: target.pr_title,
      head: target.pr_branch,
      base,
      body,
    });
    if (target.labels.length > 0) {
      await github
        .post(`/repos/${repo}/issues/${created.number}/labels`, { labels: target.labels })
        .catch((error: Error) => console.warn(`${repo}: could not add labels: ${error.message}`));
    }
    return report(repo, `opened ${created.html_url}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Runs the fixer and returns its summary (what it writes to stderr). */
function check(
  target: Target,
  { lspBin, clone, work, env }: { lspBin: string; clone: string; work: string; env: NodeJS.ProcessEnv },
): string {
  const only = target.only.length > 0 ? ['--only', target.only.join(',')] : [];
  // The remaining findings go to stdout and can be huge; only the summary matters here.
  const findings = openSync(join(work, 'findings.txt'), 'w');
  try {
    const result = spawnSync(
      lspBin,
      ['--color', 'never', 'check', '--fix', '--fail-on', 'off', ...only, ...target.args, ...target.paths],
      { cwd: clone, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', findings, 'pipe'] },
    );
    if (result.error) {
      throw new Error(`${lspBin}: ${result.error.message}`);
    }
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
      throw new Error(`shopware-lsp check exited with ${result.status}`);
    }
    return result.stderr.trim();
  } finally {
    closeSync(findings);
  }
}

function pullRequestBody(
  target: Target,
  { base, lspVersion, summary }: { base: string; lspVersion: string; summary: string },
): string {
  const { GITHUB_REPOSITORY: bot, GITHUB_SERVER_URL: server } = process.env;
  const maintainer = bot ? `[${bot}](${server}/${bot})` : 'the shopware-lsp upgrader bot';
  const code = (values: string[]) => values.map((value) => `\`${value}\``).join(', ');
  const lines = [
    'Automated fixes from [`shopware-lsp check --fix`](https://github.com/shopware/shopware-lsp).',
    '',
    `- Version: \`${lspVersion}\``,
    `- Base: \`${base}\``,
    `- Paths: ${code(target.paths)}`,
    `- Rules: ${target.only.length > 0 ? code(target.only) : 'all'}`,
  ];
  if (summary) {
    lines.push(
      '',
      '<details><summary>What is left after the fixes</summary>',
      '',
      '```',
      summary.slice(-SUMMARY_LIMIT).replaceAll('```', "'''"),
      '```',
      '',
      '</details>',
    );
  }
  lines.push(
    '',
    `Maintained by ${maintainer}. The branch is force-pushed whenever the fixes change, so commits added here are lost; close the pull request to reject these fixes.`,
  );
  return lines.join('\n');
}

function report(repo: string, outcome: string): string {
  const line = `${repo}: ${outcome}`;
  console.log(`==> ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  }
  return line;
}
