# shopware-lsp upgrader bot

Runs [`shopware-lsp check --fix`](https://github.com/shopware/shopware-lsp) on
a list of repositories and opens a pull request with the fixes.

For every repository in [`repositories.ts`](repositories.ts) the
[scheduled workflow](.github/workflows/upgrade.yml):

1. clones the base branch,
2. installs the dependencies so the index knows Shopware and the vendors
   (see [plugin or project](#plugin-or-project)),
3. runs `shopware-lsp check --fix` on the configured paths,
4. commits the changed tracked files, force-pushes them to `pr_branch` in
   the bot account's **fork** of the repository, and opens a pull request
   from there, or updates the one that is already open.

The bot never pushes to a target repository and needs no write access to it.
The fork is created on the first run with fixes and synced before each push.

Nothing is pushed when the fixes are the same as on the last run. When nothing
is left to fix, an open bot pull request is closed and its branch deleted. A
bot pull request that somebody closed is not reopened for the same fixes.

## Setup

Add a repository secret `BOT_GITHUB_TOKEN`: a classic personal access token
of the bot account with the scopes `public_repo` (`repo` when a target is
private) and `workflow`. It forks into that account, pushes to the forks and
opens the pull requests. `workflow` is needed because syncing a fork can carry
upstream changes to workflow files. A fine-grained token cannot open a pull
request in a repository of another owner. Commits are authored as the token's
user; override with `BOT_GIT_NAME` / `BOT_GIT_EMAIL`.

## Configuration

[`repositories.ts`](repositories.ts) is typed, so an editor completes the
options and flags a wrong one, and the `Check` workflow rejects it in a pull
request:

```ts
import { defineConfig } from './src/config.ts';

export default defineConfig({
  lsp: {
    // 'latest' (newest release, pre-releases included), a release tag such as
    // '0.3.61', or 'source:<branch|tag|commit>' of shopware/shopware-lsp.
    version: 'source:feat/rust-port',
  },
  // Applied to every repository; an entry may override any of them.
  defaults: {
    paths: ['.'],              // files or directories to check
    only: [],                  // rule IDs or prefixes ('twig.html.*'); empty = all
    args: [],                  // extra `check` flags, e.g. '--allow-unsupported-project'
    composer_install: true,    // false checks the clone as it is
    npm_install: true,         // npm ci for Shopware's Administration and Storefront
    compile_container: true,   // boot once with bin/ci so var/cache has the container
    pr_branch: 'shopware-lsp/auto-fix',
    pr_title: 'chore: apply shopware-lsp fixes',
    commit_message: 'chore: apply shopware-lsp fixes',
    labels: [],
  },
  repositories: [
    { repo: 'shopware/SwagExample', type: 'plugin' },
    {
      repo: 'shopware/SwagOther',
      type: 'plugin',
      shopware_version: '~6.6.0', // default: the plugin's shopware/core requirement
      only: ['php.unusedImport'],
    },
    {
      repo: 'shopware/some-shop',
      type: 'project',
      branch: 'trunk',         // base branch; default is the default branch
      paths: ['src', 'custom/static-plugins'],
    },
  ],
});
```

### Plugin or project

Every entry says what the repository is:

- `type: 'plugin'`: one Shopware plugin. The bot creates a shop with
  `composer create-project shopware/production`, moves the clone to
  `custom/plugins/<name>` and requires the plugin into the shop, so it is
  checked against Shopware and its own dependencies. The Shopware version is
  the newest one the plugin's `shopware/core` requirement allows, or
  `shopware_version`.
- `type: 'project'`: a whole Shopware or Symfony project. The bot runs
  `composer install` in the clone and checks it in place.

In both cases the bot then, where the files exist:

- runs `npm ci --ignore-scripts` for Shopware's Administration and Storefront
  (`npm_install`), so their JavaScript dependencies are known,
- boots the shop once with `bin/ci --env=dev` and a placeholder database
  (`compile_container`), so the compiled container is in `var/cache` and
  services and parameters are known.

A failure of either is logged and the check goes on without it.

No Composer or npm scripts and no Composer plugins of the checked code run
during the installs; only Symfony Flex of the Shopware template does, to lay
out the shop. `compile_container` is different: booting the shop **runs the
PHP code of the repository and its dependencies** on the runner, in the job
that holds `BOT_GITHUB_TOKEN`. List only repositories you trust, or set
`compile_container: false` for the others.

No release ships `check --fix` yet, so `lsp.version` points at the branch that
has it. For a `source:<ref>` version the bot downloads the newest binary that
shopware-lsp's own workflows built for that branch or commit (the
`server-<target>` artifacts, kept for a week). Only when none is left does it
build the commit itself, which takes much longer. Switch to `latest` after the
first release with `--fix`.

## Running it

The workflow runs every Monday at 05:00 UTC. **Run workflow** starts it by
hand, optionally for one repository and as a dry run.

Locally (Node 24+; running the bot needs no `npm install`):

```bash
export BOT_GITHUB_TOKEN=...
node bin/bot.ts run owner/name --dry-run --lsp ~/Developer/shopware-lsp/target/release/shopware-lsp
```

`--dry-run` clones and fixes, prints the diff stat, and pushes nothing.
`node bin/bot.ts --help` lists the other commands.

The sources are TypeScript that Node runs directly, so only erasable syntax is
allowed. `npm ci && npm run check` type-checks them and the configuration;
TypeScript is the only dependency, and only for that.
