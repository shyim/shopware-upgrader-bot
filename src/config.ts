import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Settings of one repository; every one of them has a default. */
export interface RepositoryOptions {
  /** Base branch. Default: the repository's default branch. */
  branch?: string;
  /** Files or directories to check, relative to the repository root. Default: `['.']`. */
  paths?: string[];
  /** Rule IDs or prefixes (`twig.html.*`) to fix. Default: every rule. */
  only?: string[];
  /** Extra flags for `shopware-lsp check`, e.g. `--allow-unsupported-project`. */
  args?: string[];
  /**
   * Install the dependencies first so the index knows Shopware and the
   * vendors: `composer install` for a project, a Shopware shop built around a
   * plugin. `false` checks the clone as it is. Default: `true`.
   */
  composer_install?: boolean;
  /**
   * Run `npm ci` (without scripts) for Shopware's Administration and
   * Storefront, so their JavaScript dependencies are known. Default: `true`.
   */
  npm_install?: boolean;
  /**
   * Boot the shop once with `bin/ci`, without a database, so the compiled
   * container is in var/cache and services and parameters are known. This
   * runs the PHP code of the repository on the runner. Default: `true`.
   */
  compile_container?: boolean;
  /**
   * Composer constraint of the shop a plugin is checked in. Default: the
   * plugin's own `shopware/core` requirement, of which the newest match is used.
   */
  shopware_version?: string;
  /** Branch the bot force-pushes to. Default: `shopware-lsp/auto-fix`. */
  pr_branch?: string;
  pr_title?: string;
  commit_message?: string;
  /** Labels for a new pull request; they must exist in the repository. */
  labels?: string[];
}

export interface RepositoryEntry extends RepositoryOptions {
  /** `owner/name` on github.com. */
  repo: `${string}/${string}`;
  /**
   * `plugin`: the repository is one Shopware plugin. A Shopware shop is
   * created around it and the plugin is required into it, so the plugin is
   * checked against the Shopware and the dependencies it runs with.
   * `project`: the repository is a whole Shopware or Symfony project and is
   * checked in place.
   */
  type: 'plugin' | 'project';
}

/**
 * Which shopware-lsp to run: the newest release (pre-releases included), a
 * release tag, or a branch, tag or commit of shopware/shopware-lsp. For the
 * last one a binary its workflows built is used, else it is built here.
 */
export type LspVersion = 'latest' | `${number}.${number}.${number}` | `source:${string}`;

/** The shape of repositories.ts. */
export interface BotConfig {
  lsp?: { version?: LspVersion };
  /** Applied to every repository; an entry may override any of them. */
  defaults?: RepositoryOptions;
  repositories: RepositoryEntry[];
}

/** Types the default export of repositories.ts. */
export const defineConfig = (config: BotConfig): BotConfig => config;

/** One repository, merged with the defaults. */
export type Target = Required<RepositoryEntry>;

export interface Config {
  lspVersion: string;
  repositories: Target[];
}

const BUILT_IN_DEFAULTS: Required<RepositoryOptions> = {
  branch: '',
  paths: ['.'],
  only: [],
  args: [],
  composer_install: true,
  npm_install: true,
  compile_container: true,
  shopware_version: '',
  pr_branch: 'shopware-lsp/auto-fix',
  pr_title: 'chore: apply shopware-lsp fixes',
  commit_message: 'chore: apply shopware-lsp fixes',
  labels: [],
};

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/** Loads repositories.ts (or `CONFIG_FILE`) and merges every entry with the defaults. */
export async function loadConfig(): Promise<Config> {
  const file = process.env.CONFIG_FILE
    ? pathToFileURL(resolve(process.env.CONFIG_FILE))
    : new URL('../repositories.ts', import.meta.url);
  const raw = ((await import(file.href)) as { default?: BotConfig }).default;
  if (!raw || !Array.isArray(raw.repositories)) {
    throw new Error(`${file.pathname} must default-export a config with a repositories list`);
  }
  return resolveConfig(raw);
}

/**
 * Merges every entry with the defaults. The types catch most mistakes in an
 * editor; this also holds when the bot runs without a type check.
 */
export function resolveConfig(raw: BotConfig): Config {
  const defaults = { ...BUILT_IN_DEFAULTS, ...raw.defaults };

  const repositories = raw.repositories.map((entry) => {
    const target = { ...defaults, ...entry };
    validate(target, entry);
    return target;
  });

  const names = repositories.map((target) => target.repo.toLowerCase());
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) {
    throw new Error(`${duplicate} is listed twice`);
  }

  return { lspVersion: String(raw.lsp?.version ?? 'latest'), repositories };
}

/** The configured repositories, or the one named by `filter`. */
export function selectRepositories(config: Config, filter?: string): Target[] {
  if (!filter) {
    return config.repositories;
  }
  const selected = config.repositories.filter(
    (target) => target.repo.toLowerCase() === filter.toLowerCase(),
  );
  if (selected.length === 0) {
    throw new Error(`${filter} is not listed in repositories.ts`);
  }
  return selected;
}

/** Rejects the values the types cannot rule out. */
function validate(target: Target, entry: unknown): void {
  const repo: unknown = target.repo;
  if (typeof repo !== 'string' || !REPOSITORY.test(repo) || repo.split('/').some((part) => /^\.+$/.test(part))) {
    throw new Error(`invalid repository entry: ${JSON.stringify(entry)}`);
  }
  if (target.type !== 'plugin' && target.type !== 'project') {
    throw new Error(`${repo}: type must be 'plugin' or 'project'`);
  }
  for (const key of ['paths', 'only', 'args', 'labels'] as const) {
    const list: unknown = target[key];
    if (!Array.isArray(list) || list.some((value) => typeof value !== 'string')) {
      throw new Error(`${repo}: ${key} must be a list of strings`);
    }
  }
  if (target.paths.length === 0) {
    throw new Error(`${repo}: paths must not be empty`);
  }
  // Paths end up as arguments of shopware-lsp and git inside the clone.
  for (const path of target.paths) {
    if (path.startsWith('-') || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`${repo}: path ${JSON.stringify(path)} must stay inside the repository`);
    }
  }
  for (const key of ['pr_branch', 'pr_title', 'commit_message'] as const) {
    const value: unknown = target[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${repo}: ${key} must not be empty`);
    }
  }
  if (target.pr_branch.startsWith('-')) {
    throw new Error(`${repo}: invalid pr_branch`);
  }
  if (typeof target.branch !== 'string' || target.branch.startsWith('-')) {
    throw new Error(`${repo}: invalid branch`);
  }
  if (typeof target.shopware_version !== 'string' || target.shopware_version.startsWith('-')) {
    throw new Error(`${repo}: invalid shopware_version`);
  }
}
