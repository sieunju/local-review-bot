export interface PullRequest {
  number: number;
  title: string;
}

export interface GitProvider {
  fetchOpenPullRequests(): Promise<PullRequest[]>;
  fetchDiff(prNumber: number): Promise<string>;
  postComment(prNumber: number, body: string): Promise<void>;
}

interface ProviderConfig {
  url: string;
  token: string;
  owner: string;
  repo: string;
}

class GiteaProvider implements GitProvider {
  constructor(private config: ProviderConfig) {}

  private async request(urlPath: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.config.url}/api/v1${urlPath}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `token ${this.config.token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Gitea API error: ${res.status}`);
    }
    return res;
  }

  async fetchOpenPullRequests(): Promise<PullRequest[]> {
    const res = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls?state=open`
    );
    return res.json();
  }

  async fetchDiff(prNumber: number): Promise<string> {
    const res = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}.diff`
    );
    return res.text();
  }

  async postComment(prNumber: number, body: string): Promise<void> {
    await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  }
}

class GithubProvider implements GitProvider {
  constructor(private config: ProviderConfig) {}

  private async request(urlPath: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.config.url}${urlPath}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status}`);
    }
    return res;
  }

  async fetchOpenPullRequests(): Promise<PullRequest[]> {
    const res = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls?state=open`
    );
    return res.json();
  }

  async fetchDiff(prNumber: number): Promise<string> {
    const res = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}`,
      { headers: { Accept: "application/vnd.github.v3.diff" } }
    );
    return res.text();
  }

  async postComment(prNumber: number, body: string): Promise<void> {
    await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  }
}

class GitlabProvider implements GitProvider {
  private projectId: string;

  constructor(private config: ProviderConfig) {
    this.projectId = encodeURIComponent(`${config.owner}/${config.repo}`);
  }

  private async request(urlPath: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.config.url}/api/v4${urlPath}`, {
      ...init,
      headers: {
        ...init?.headers,
        "PRIVATE-TOKEN": this.config.token,
      },
    });
    if (!res.ok) {
      throw new Error(`GitLab API error: ${res.status}`);
    }
    return res;
  }

  async fetchOpenPullRequests(): Promise<PullRequest[]> {
    const res = await this.request(
      `/projects/${this.projectId}/merge_requests?state=opened`
    );
    const mrs: Array<{ iid: number; title: string }> = await res.json();
    return mrs.map((mr) => ({ number: mr.iid, title: mr.title }));
  }

  async fetchDiff(prNumber: number): Promise<string> {
    const res = await this.request(
      `/projects/${this.projectId}/merge_requests/${prNumber}/changes`
    );
    const data: { changes: Array<{ old_path: string; new_path: string; diff: string }> } =
      await res.json();
    return data.changes
      .map((c) => `diff --git a/${c.old_path} b/${c.new_path}\n${c.diff}`)
      .join("\n");
  }

  async postComment(prNumber: number, body: string): Promise<void> {
    await this.request(
      `/projects/${this.projectId}/merge_requests/${prNumber}/notes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  }
}

export function createGitProvider(config: ProviderConfig): GitProvider {
  const provider = (process.env.GIT_PROVIDER ?? "gitea").toLowerCase();
  switch (provider) {
    case "gitea":
      return new GiteaProvider(config);
    case "github":
      return new GithubProvider(config);
    case "gitlab":
      return new GitlabProvider(config);
    default:
      throw new Error(`Unknown GIT_PROVIDER: ${provider}`);
  }
}
