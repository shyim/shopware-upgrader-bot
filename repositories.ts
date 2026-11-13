import { defineConfig } from './src/config.ts';

// Repositories the bot keeps fixed with `shopware-lsp check --fix`.
// The schedule lives in .github/workflows/upgrade.yml.
export default defineConfig({
  lsp: {
    // No release ships `check --fix` yet, so use the branch that has it: its
    // prebuilt binary, or a build of it when none is left.
    // Switch to 'latest' after the first release with `--fix`.
    version: 'source:feat/rust-port',
  },

  // Applied to every repository; an entry may override any of them.
  defaults: {
    paths: ['.'],
    composer_install: true,
    pr_branch: 'shopware-lsp/auto-fix',
    pr_title: 'chore: apply shopware-lsp fixes',
    commit_message: 'chore: apply shopware-lsp fixes',
  },

  repositories: [
    { repo: 'FriendsOfShopware/FroshTools', type: 'plugin' },
    { repo: 'FriendsOfShopware/FroshPlatformMailArchive', type: 'plugin' },
  ],
});
