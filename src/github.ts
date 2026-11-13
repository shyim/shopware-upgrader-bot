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
}

/** A minimal GitHub REST client. The token is optional for public reads. */
export function createGitHub(token?: string): GitHub {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'shopware-upgrader-bot',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
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

    async download(url) {
      const response = await fetch(url, { headers: { 'user-agent': headers['user-agent']! } });
      if (!response.ok) {
        throw new Error(`GET ${url}: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
