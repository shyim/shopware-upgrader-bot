#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig, selectRepositories } from '../src/config.ts';
import { createGitHub } from '../src/github.ts';
import { downloadLsp, downloadLspArtifact, resolveLsp, verifyLsp } from '../src/lsp.ts';
import { upgradeRepository, type UpgradeOptions } from '../src/upgrade.ts';

const USAGE = `Usage:
  bot.ts run [owner/name] [--dry-run] [--lsp <binary>]   fix all or one repository
  bot.ts matrix [owner/name]                             print the repositories as JSON
  bot.ts lsp resolve                                     print kind=, ref= and key= of lsp.version
  bot.ts lsp download <tag> <directory>                  download a release binary
  bot.ts lsp download-artifact <id> <directory>          download a workflow artifact binary
  bot.ts lsp verify <binary>                             require a binary with check --fix

Environment:
  BOT_GITHUB_TOKEN   token that clones, pushes and opens pull requests (run)
  GITHUB_TOKEN       any GitHub token; needed to download artifacts, and it
                     raises the API rate limit of the other lsp commands
  LSP_BIN            shopware-lsp binary (default: shopware-lsp on PATH)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    lsp: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const [command, ...rest] = positionals;

async function main(): Promise<void> {
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'matrix': {
      const targets = selectRepositories(await loadConfig(), rest[0]);
      console.log(JSON.stringify(targets.map((target) => target.repo)));
      return;
    }

    case 'lsp': {
      const github = createGitHub(process.env.GITHUB_TOKEN);
      const [action, ...args] = rest;
      if (action === 'resolve') {
        const resolved = await resolveLsp(github, (await loadConfig()).lspVersion);
        console.log(Object.entries(resolved).map(([key, value]) => `${key}=${value}`).join('\n'));
      } else if (action === 'download' && args.length === 2) {
        console.log(await downloadLsp(github, args[0]!, args[1]!));
      } else if (action === 'download-artifact' && args.length === 2) {
        console.log(await downloadLspArtifact(github, args[0]!, args[1]!));
      } else if (action === 'verify' && args.length === 1) {
        console.log(verifyLsp(args[0]!));
      } else {
        throw new Error(USAGE);
      }
      return;
    }

    case 'run': {
      const token = process.env.BOT_GITHUB_TOKEN;
      if (!token) {
        throw new Error('BOT_GITHUB_TOKEN is not set');
      }
      // Child processes get it only where they need it.
      delete process.env.BOT_GITHUB_TOKEN;
      const options: UpgradeOptions = {
        github: createGitHub(token),
        token,
        lspBin: values.lsp ?? process.env.LSP_BIN ?? 'shopware-lsp',
        dryRun: values['dry-run'],
      };

      const failed: string[] = [];
      for (const target of selectRepositories(await loadConfig(), rest[0])) {
        try {
          await upgradeRepository(target, options);
        } catch (error) {
          console.error(`==> ${target.repo}: failed: ${(error as Error).message}`);
          failed.push(target.repo);
        }
      }
      if (failed.length > 0) {
        throw new Error(`failed: ${failed.join(', ')}`);
      }
      return;
    }

    default:
      throw new Error(USAGE);
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
