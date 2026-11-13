import { spawnSync } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Return stdout instead of inheriting the output. */
  capture?: boolean;
}

/** Runs a command; `null` when it exits unsuccessfully, else its trimmed stdout. */
export function tryRun(command: string, args: string[], options: RunOptions = {}): string | null {
  const result = spawn(command, args, options);
  return result.status === 0 ? result.stdout : null;
}

/** Runs a command and returns its trimmed stdout; a non-zero exit throws. */
export function run(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawn(command, args, options);
  if (result.status !== 0) {
    const detail = result.stderr ? `\n${result.stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${detail}`);
  }
  return result.stdout;
}

function spawn(command: string, args: string[], { cwd, env, capture = false }: RunOptions) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) {
    throw new Error(`${command}: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}
