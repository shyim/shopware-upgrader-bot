import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Target } from './config.ts';
import { run, tryRun, type RunOptions } from './exec.ts';
import type { GitHub, PullRequest } from './github.ts';
import { verifyLsp } from './lsp.ts';

const SUMMARY_LIMIT = 4000;

/** Scripts and plugins of the checked code never run; platform requirements do not matter for an index. */
const COMPOSER_FLAGS = ['--no-interaction', '--no-progress', '--no-scripts', '--ignore-platform-reqs'];
const COMPOSER_PACKAGE = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;

/** Where the fixer runs, and where the cloned repository is inside it. */
interface Workspace {
  /** Workspace root handed to shopware-lsp. */
  root: string;
  /** The git checkout: `root` itself, or the plugin directory of a shop. */
  checkout: string;
  /** `checkout` relative to `root`. */
  prefix: string;
}

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
 * request with the result up to date. The bot never pushes to the repository
 * itself: the fixes go to a fork owned by the token's user, and the pull
 * request comes from there. Returns a one-line outcome.
 */
export async function upgradeRepository(
  target: Target,
  { github, token, lspBin, dryRun = false }: UpgradeOptions,
): Promise<string> {
  const { repo } = target;

  // The token reaches git only, and only for github.com; composer and the
  // language server run without it.
  const { BOT_GITHUB_TOKEN: _token, ...env } = process.env;
  const lspVersion = verifyLsp(lspBin, env);
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
  let checkout = clone;
  // Composer and the fixer write into the clone before git commits and pushes
  // with the token, so nothing they could leave in .git may run.
  const safe = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  const git = (args: string[], options: RunOptions = {}) =>
    run('git', [...safe, ...args], { cwd: checkout, env, ...options });
  const gitSucceeds = (args: string[], options: RunOptions = {}) =>
    tryRun('git', [...safe, ...args], { cwd: checkout, env, capture: true, ...options }) !== null;

  try {
    console.log(`==> ${repo}: cloning ${base}`);
    run('git', ['clone', '--depth', '1', '--branch', base, `https://github.com/${repo}.git`, clone], {
      env: gitEnv,
    });

    // Code of the repository may run from here on. Whatever it does to the
    // git configuration (a proxy, a rewritten URL, a filter) is undone before
    // git works with the token again.
    const gitConfig = readFileSync(join(clone, '.git', 'config'));
    const workspace = prepareWorkspace(target, { clone, work, env });
    checkout = workspace.checkout;

    console.log(`==> ${repo}: ${lspVersion} check --fix`);
    const summary = check(target, { lspBin, workspace, work, env });
    writeFileSync(join(checkout, '.git', 'config'), gitConfig);

    git(['add', '--update', '--', ...target.paths]);
    const changed = !gitSucceeds(['diff', '--cached', '--quiet']);
    const user = await github.get<{ login: string; id: number }>('/user');
    const head = `${user.login}:${target.pr_branch}`;
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
      if (obsolete.head.repo) {
        await github.delete(`/repos/${obsolete.head.repo.full_name}/git/refs/heads/${target.pr_branch}`);
      }
      return report(repo, `nothing to fix, closed ${obsolete.html_url}`);
    }

    const name = process.env.BOT_GIT_NAME ?? user.login;
    const email = process.env.BOT_GIT_EMAIL ?? `${user.id}+${user.login}@users.noreply.github.com`;
    git([
      '-c', `user.name=${name}`,
      '-c', `user.email=${email}`,
      'commit', '--quiet', '--no-verify', '--message', target.commit_message,
    ]);

    const fork = await ensureFork(github, { repo, base, login: user.login, gitEnv });
    const remote = `https://github.com/${fork}.git`;

    // Push only when the result differs from what the branch already holds, so
    // an unchanged run does not retrigger the target's CI.
    const ref = `refs/heads/${target.pr_branch}`;
    const upToDate =
      gitSucceeds(['fetch', '--quiet', '--depth', '1', remote, ref], { env: gitEnv }) &&
      gitSucceeds(['diff', '--quiet', 'FETCH_HEAD', 'HEAD']);
    if (!upToDate) {
      const push = ['push', '--quiet', '--force', '--no-verify', remote, `HEAD:${ref}`];
      if (!gitSucceeds(push, { env: gitEnv })) {
        // A fork that could not be synced lacks the base commit, and a shallow
        // clone cannot supply its history.
        console.log(`==> ${repo}: fetching the full history for ${fork}`);
        git(['fetch', '--quiet', '--unshallow', 'origin'], { env: gitEnv });
        git(push, { env: gitEnv });
      }
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
      head,
      base,
      body,
      ...(fork === repo ? {} : { maintainer_can_modify: true }),
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

/**
 * Returns the repository of the token's user to push to: its fork of `repo`,
 * created when missing and synced with the base branch. A repository the
 * user owns is pushed to directly, since it cannot be forked by its owner.
 */
async function ensureFork(
  github: GitHub,
  { repo, base, login, gitEnv }: { repo: string; base: string; login: string; gitEnv: NodeJS.ProcessEnv },
): Promise<string> {
  if (repo.split('/')[0]!.toLowerCase() === login.toLowerCase()) {
    return repo;
  }

  // Answers with the existing fork when there is one.
  const { full_name: fork } = await github.post<{ full_name: string }>(`/repos/${repo}/forks`, {});
  const remote = `https://github.com/${fork}.git`;
  // Forking is asynchronous: wait until the fork has branches.
  for (let attempt = 0; ; attempt++) {
    if (tryRun('git', ['ls-remote', '--exit-code', '--heads', remote], { env: gitEnv, capture: true }) !== null) {
      break;
    }
    if (attempt === 30) {
      throw new Error(`${fork} was not ready after forking ${repo}`);
    }
    await sleep(4000);
  }

  // The commit is based on the upstream branch, so the fork needs that
  // history. Without it the push falls back to sending the full history.
  await github
    .post(`/repos/${fork}/merge-upstream`, { branch: base })
    .catch((error: Error) => console.warn(`${repo}: could not sync ${fork}: ${error.message}`));
  return fork;
}

/**
 * Installs what the index needs to know the code's dependencies: the vendors
 * of a project, or a Shopware shop around a plugin.
 */
function prepareWorkspace(
  target: Target,
  { clone, work, env }: { clone: string; work: string; env: NodeJS.ProcessEnv },
): Workspace {
  const { repo } = target;
  // The packages are only read by the index, never run or deployed, so
  // Composer's advisory, abandonment and cooldown policies must not stop the
  // install. The variables cover Composer versions the flags do not.
  env = { ...env, COMPOSER_NO_AUDIT: '1', COMPOSER_NO_BLOCKING: '1', COMPOSER_NO_SECURITY_BLOCKING: '1' };
  const standalone: Workspace = { root: clone, checkout: clone, prefix: '' };
  const manifestFile = join(clone, 'composer.json');
  if (!target.composer_install) {
    return standalone;
  }

  if (target.type === 'project') {
    if (existsSync(manifestFile)) {
      console.log(`==> ${repo}: composer install`);
      run('composer', ['install', ...COMPOSER_FLAGS, '--no-plugins'], { cwd: clone, env });
    }
    prepareShop(target, clone, env);
    return standalone;
  }

  if (!existsSync(manifestFile)) {
    throw new Error('a plugin needs a composer.json; set composer_install: false to check it as it is');
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    name?: string;
    require?: Record<string, string>;
  };
  if (!manifest.name || !COMPOSER_PACKAGE.test(manifest.name)) {
    throw new Error(`composer.json has no valid package name: ${JSON.stringify(manifest.name)}`);
  }
  const constraint = target.shopware_version || manifest.require?.['shopware/core'] || '';
  if (constraint.startsWith('-')) {
    throw new Error(`invalid Shopware constraint ${JSON.stringify(constraint)}`);
  }

  // The template's own plugins (Symfony Flex) lay out the project; its scripts
  // would boot the shop, which needs a database.
  const shop = join(work, 'shop');
  console.log(`==> ${repo}: creating a Shopware ${constraint || 'latest'} shop`);
  run('composer', ['create-project', ...COMPOSER_FLAGS, 'shopware/production', shop, ...(constraint ? [constraint] : [])], {
    cwd: work,
    env,
  });

  // custom/plugins/* is a path repository of the template, so the plugin is
  // linked into vendor/ and its dependencies are installed next to Shopware.
  const prefix = join('custom', 'plugins', repo.split('/')[1]!);
  mkdirSync(join(shop, 'custom', 'plugins'), { recursive: true });
  renameSync(clone, join(shop, prefix));
  console.log(`==> ${repo}: composer require ${manifest.name}`);
  run(
    'composer',
    ['require', ...COMPOSER_FLAGS, '--no-plugins', '--with-all-dependencies', `${manifest.name}:*@dev`],
    { cwd: shop, env },
  );
  prepareShop(target, shop, env);
  return { root: shop, checkout: join(shop, prefix), prefix };
}

/**
 * Adds what the index reads beyond the PHP vendors: the JavaScript
 * dependencies of Shopware's Administration and Storefront, and the compiled
 * container. Both only widen what is known, so a failure is not fatal.
 */
function prepareShop(target: Target, root: string, env: NodeJS.ProcessEnv): void {
  const { repo } = target;
  // npm reads configuration of the directory it runs in, and bin/ci runs the
  // repository's PHP code: neither gets more of the bot's environment than a
  // program needs to start.
  const { PATH, HOME, TMPDIR, LANG } = env;
  const bare = { PATH, HOME, TMPDIR, LANG };

  if (target.npm_install) {
    for (const name of ['administration', 'storefront']) {
      const app = join(root, 'vendor', 'shopware', name, 'Resources', 'app', name);
      // Only an exact, locked install.
      if (!existsSync(join(app, 'package-lock.json'))) {
        continue;
      }
      console.log(`==> ${repo}: npm ci for the ${name}`);
      if (tryRun('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, env: bare }) === null) {
        console.warn(`==> ${repo}: npm ci failed for the ${name}, continuing without it`);
      }
    }
  }

  // bin/ci boots Shopware with the plugins Composer knows and a placeholder
  // database; the dev environment dumps the container the index reads.
  if (target.compile_container && existsSync(join(root, 'bin', 'ci'))) {
    console.log(`==> ${repo}: compiling the container with bin/ci`);
    const booted = tryRun('php', ['bin/ci', '--env=dev', 'list', '--quiet'], {
      cwd: root,
      env: { ...bare, APP_ENV: 'dev', DATABASE_URL: '' },
    });
    if (booted === null) {
      console.warn(`==> ${repo}: bin/ci failed, continuing without the compiled container`);
    }
  }
}

/** Runs the fixer and returns its summary (what it writes to stderr). */
function check(
  target: Target,
  { lspBin, workspace, work, env }: { lspBin: string; workspace: Workspace; work: string; env: NodeJS.ProcessEnv },
): string {
  const paths = target.paths.map((path) => join(workspace.prefix, path));
  const only = target.only.length > 0 ? ['--only', target.only.join(',')] : [];
  // The remaining findings go to stdout and can be huge; only the summary matters here.
  const findings = openSync(join(work, 'findings.txt'), 'w');
  try {
    const result = spawnSync(
      lspBin,
      ['--color', 'never', 'check', '--fix', '--fail-on', 'off', ...only, ...target.args, ...paths],
      { cwd: workspace.root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', findings, 'pipe'] },
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
    `Maintained by ${maintainer}. The branch is force-pushed whenever the fixes change, so commits added to it are lost; close the pull request to reject these fixes.`,
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
