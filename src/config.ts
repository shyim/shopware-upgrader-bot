import { readFileSync } from 'node:fs';

/** One repository of repositories.json, merged with the defaults. */
export interface Target {
  /** `owner/name` on github.com. */
  repo: string;
  /** Base branch; empty selects the repository's default branch. */
  branch: string;
  /** Files or directories to check, relative to the repository root. */
  paths: string[];
  /** Rule IDs or prefixes (`twig.html.*`) to fix; empty fixes every rule. */
  only: string[];
  /** Extra flags for `shopware-lsp check`. */
  args: string[];
  /** Run `composer install` first so the index knows Shopware and the vendors. */
  composer_install: boolean;
  /** Branch the bot force-pushes to. */
  pr_branch: string;
  pr_title: string;
  commit_message: string;
  labels: string[];
}

export interface Config {
  /** `latest`, a release tag, or `source:<git ref>`. */
  lspVersion: string;
  repositories: Target[];
}

interface RawConfig {
  lsp?: { version?: string };
  defaults?: Partial<Omit<Target, 'repo'>>;
  repositories?: (string | Partial<Target>)[];
}

const BUILT_IN_DEFAULTS: Omit<Target, 'repo'> = {
  branch: '',
  paths: ['.'],
  only: [],
  args: [],
  composer_install: true,
  pr_branch: 'shopware-lsp/auto-fix',
  pr_title: 'chore: apply shopware-lsp fixes',
  commit_message: 'chore: apply shopware-lsp fixes',
  labels: [],
};

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

export const configPath = (): string | URL =>
  process.env.CONFIG_FILE ?? new URL('../repositories.json', import.meta.url);

/** Reads repositories.json and merges every entry with the defaults. */
export function loadConfig(file: string | URL = configPath()): Config {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawConfig;
  const defaults = { ...BUILT_IN_DEFAULTS, ...raw.defaults };

  const repositories = (raw.repositories ?? []).map((entry) => {
    const target = { ...defaults, ...(typeof entry === 'string' ? { repo: entry } : entry) };
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
    throw new Error(`${filter} is not listed in repositories.json`);
  }
  return selected;
}

/** Rejects what the JSON file may hold but a target must not. */
function validate(target: Partial<Target>, entry: unknown): asserts target is Target {
  const repo = target.repo;
  if (typeof repo !== 'string' || !REPOSITORY.test(repo) || repo.split('/').some((part) => /^\.+$/.test(part))) {
    throw new Error(`invalid repository entry: ${JSON.stringify(entry)}`);
  }
  for (const key of ['paths', 'only', 'args', 'labels'] as const) {
    const list: unknown = target[key];
    if (!Array.isArray(list) || list.some((value) => typeof value !== 'string')) {
      throw new Error(`${repo}: ${key} must be a list of strings`);
    }
  }
  if (target.paths!.length === 0) {
    throw new Error(`${repo}: paths must not be empty`);
  }
  // Paths end up as arguments of shopware-lsp and git inside the clone.
  for (const path of target.paths!) {
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
  if (target.pr_branch!.startsWith('-')) {
    throw new Error(`${repo}: invalid pr_branch`);
  }
  if (typeof target.branch !== 'string' || target.branch.startsWith('-')) {
    throw new Error(`${repo}: invalid branch`);
  }
}
