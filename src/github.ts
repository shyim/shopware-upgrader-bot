const API = 'https://api.github.com';

export class GitHubError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path}: ${status} ${body.slice(0, 500)}`);
    this.status = status;
  }
}

export interface PullRequest {
  number: number;
  html_url: string;
  /** `repo` is null once the fork is deleted. */
  head: { repo: { full_name: string } | null };
}

export interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

export interface GitHub {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
  /** Downloads a release asset or any other public URL. */
  download(url: string): Promise<Buffer>;
  /** Downloads an API resource that answers with a file, such as an artifact archive. */
  getFile(path: string): Promise<Buffer>;
}

export interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run: {
    head_branch: string;
    head_sha: string;
    repository_id: number;
    head_repository_id: number;
  };
}

/** A minimal GitHub REST client. The token is optional for public reads. */
export function createGitHub(token?: string): GitHub {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'shopware-upgrader-bot',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  /**
   * The bot blocks for minutes in composer and the fixer between two calls;
   * by then GitHub has closed the kept-alive connection and the next request
   * fails before it is sent. Such a request is safe to repeat.
   */
  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetch(url, init);
      } catch (error) {
        if (attempt === 3) {
          const cause = (error as Error).cause;
          throw new Error(`${init.method ?? 'GET'} ${url}: ${(error as Error).message}`, { cause });
        }
      }
    }
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await send(`${API}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GitHubError(method, path, response.status, await response.text());
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    delete: (path) => request('DELETE', path),

    async getFile(path) {
      // fetch drops the authorization header when GitHub redirects to its storage.
      const response = await send(`${API}${path}`, { headers });
      if (!response.ok) {
        throw new GitHubError('GET', path, response.status, await response.text());
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async download(url) {
      const response = await send(url, { headers: { 'user-agent': headers['user-agent']! } });
      if (!response.ok) {
        throw new Error(`GET ${url}: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
