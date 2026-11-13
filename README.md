# shopware-lsp upgrader bot

Runs [`shopware-lsp check --fix`](https://github.com/shopware/shopware-lsp) on
a list of repositories and opens a pull request with the fixes.

For every repository in [`repositories.json`](repositories.json) the
[scheduled workflow](.github/workflows/upgrade.yml):

1. clones the base branch with the bot token,
2. runs `composer install` (no scripts, no plugins) so the index knows the vendors,
3. runs `shopware-lsp check --fix` on the configured paths,
4. commits the changed tracked files, force-pushes them to `pr_branch` and
   opens a pull request, or updates the one that is already open.

Nothing is pushed when the fixes are the same as on the last run. When nothing
is left to fix, an open bot pull request is closed and its branch deleted. A
bot pull request that somebody closed is not reopened for the same fixes.

## Setup

Add a repository secret `BOT_GITHUB_TOKEN`: a personal access token of the bot
account with **Contents: read and write** and **Pull requests: read and
write** on every target repository (classic token: `repo`). Commits are
authored as the token's user; override with `BOT_GIT_NAME` / `BOT_GIT_EMAIL`.

## Configuration

```jsonc
{
  "lsp": {
    // "latest" (newest release, pre-releases included), a release tag such as
    // "0.3.61", or "source:<branch|tag|commit>" to build shopware/shopware-lsp.
    "version": "source:feat/rust-port"
  },
  // Applied to every repository; an entry may override any key.
  "defaults": {
    "paths": ["."],              // files or directories to check
    "only": [],                  // rule IDs or prefixes ("twig.html.*"); empty = all
    "args": [],                  // extra `check` flags, e.g. "--allow-unsupported-project"
    "composer_install": true,
    "pr_branch": "shopware-lsp/auto-fix",
    "pr_title": "chore: apply shopware-lsp fixes",
    "commit_message": "chore: apply shopware-lsp fixes",
    "labels": []
  },
  "repositories": [
    "shopware/SwagExample",      // short form: defaults only
    {
      "repo": "shopware/SwagOther",
      "branch": "trunk",         // base branch; default is the default branch
      "paths": ["src", "tests"],
      "only": ["php.unusedImport"]
    }
  ]
}
```

`repositories.json` itself is plain JSON, without comments.

No release ships `check --fix` yet, so `lsp.version` builds the branch that
has it. The build is cached per commit; switch to `latest` after the first
release with `--fix`.

## Running it

The workflow runs every Monday at 05:00 UTC. **Run workflow** starts it by
hand, optionally for one repository and as a dry run.

Locally (Node 24+, no dependencies to install):

```bash
export BOT_GITHUB_TOKEN=...
node bin/bot.ts run owner/name --dry-run --lsp ~/Developer/shopware-lsp/target/release/shopware-lsp
```

`--dry-run` clones and fixes, prints the diff stat, and pushes nothing.
`node bin/bot.ts --help` lists the other commands.

The sources are TypeScript that Node runs directly, so only erasable syntax is
allowed. `tsconfig.json` is there for editors and for
`npx -p typescript -p @types/node tsc`.
