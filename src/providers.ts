export interface PullRequest {
  number: number;
  title: string;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface PostedComment {
  id: number;
  path: string;
  line: number;
}

export interface PrComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface DiffRefs {
  headSha: string;
  baseSha?: string;
  startSha?: string;
}

export interface GitProvider {
  fetchOpenPullRequests(): Promise<PullRequest[]>;
  fetchDiff(prNumber: number): Promise<string>;
  fetchDiffRefs(prNumber: number): Promise<DiffRefs>;
  // General (non-inline) PR comments, used to detect manual trigger commands.
  fetchComments(prNumber: number): Promise<PrComment[]>;
  postReview(
    prNumber: number,
    refs: DiffRefs,
    summary: string,
    comments: InlineComment[]
  ): Promise<PostedComment[]>;
  // Only Gitea supports resolving individual review comments right now.
  resolveComments?(commentIds: number[]): Promise<void>;
}

interface ProviderConfig {
  url: string;
  token: string;
  owner: string;
  repo: string;
}

export interface ProjectConfig {
  provider: string;
  url?: string;
  token: string;
  owner: string;
  repo: string;
  stack?: string;
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

  async fetchDiffRefs(prNumber: number): Promise<DiffRefs> {
    const res = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}`
    );
    const data: { head: { sha: string } } = await res.json();
    return { headSha: data.head.sha };
  }

  async fetchComments(prNumber: number): Promise<PrComment[]> {
    const res = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments`
    );
    const data: Array<{ id: number; body: string; created_at: string }> = await res.json();
    return data.map((c) => ({ id: c.id, body: c.body ?? "", createdAt: c.created_at }));
  }

  async postReview(
    prNumber: number,
    refs: DiffRefs,
    summary: string,
    comments: InlineComment[]
  ): Promise<PostedComment[]> {
    const res = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commit_id: refs.headSha,
          event: "COMMENT",
          body: summary,
          comments: comments.map((c) => ({
            path: c.path,
            // Gitea positions are real file line numbers; an added line
            // has only a new-file position.
            new_position: c.line,
            old_position: 0,
            body: c.body,
          })),
        }),
      }
    );
    if (comments.length === 0) {
      return [];
    }
    const review: { id: number } = await res.json();
    const createdRes = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}/reviews/${review.id}/comments`
    );
    const created: Array<{ id: number }> = await createdRes.json();
    // Gitea returns created comments in the same order they were submitted.
    return created.map((c, i) => ({ id: c.id, path: comments[i].path, line: comments[i].line }));
  }

  async resolveComments(commentIds: number[]): Promise<void> {
    for (const id of commentIds) {
      await this.request(`/repos/${this.config.owner}/${this.config.repo}/pulls/comments/${id}/resolve`, {
        method: "POST",
      });
    }
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

  async fetchDiffRefs(prNumber: number): Promise<DiffRefs> {
    const res = await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}`
    );
    const data: { head: { sha: string } } = await res.json();
    return { headSha: data.head.sha };
  }

  async fetchComments(prNumber: number): Promise<PrComment[]> {
    const all: PrComment[] = [];
    for (let page = 1; ; page++) {
      const res = await this.request(
        `/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments?per_page=100&page=${page}`
      );
      const data: Array<{ id: number; body: string; created_at: string }> = await res.json();
      all.push(...data.map((c) => ({ id: c.id, body: c.body ?? "", createdAt: c.created_at })));
      if (data.length < 100) {
        return all;
      }
    }
  }

  async postReview(
    prNumber: number,
    refs: DiffRefs,
    summary: string,
    comments: InlineComment[]
  ): Promise<PostedComment[]> {
    await this.request(
      `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commit_id: refs.headSha,
          event: "COMMENT",
          body: summary,
          comments: comments.map((c) => ({
            path: c.path,
            line: c.line,
            body: c.body,
          })),
        }),
      }
    );
    return [];
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

  async fetchDiffRefs(prNumber: number): Promise<DiffRefs> {
    const res = await this.request(
      `/projects/${this.projectId}/merge_requests/${prNumber}`
    );
    const data: {
      diff_refs: { base_sha: string; start_sha: string; head_sha: string };
    } = await res.json();
    return {
      headSha: data.diff_refs.head_sha,
      baseSha: data.diff_refs.base_sha,
      startSha: data.diff_refs.start_sha,
    };
  }

  async fetchComments(prNumber: number): Promise<PrComment[]> {
    const all: PrComment[] = [];
    for (let page = 1; ; page++) {
      const res = await this.request(
        `/projects/${this.projectId}/merge_requests/${prNumber}/notes?per_page=100&page=${page}`
      );
      const data: Array<{ id: number; body: string; created_at: string }> = await res.json();
      all.push(...data.map((c) => ({ id: c.id, body: c.body ?? "", createdAt: c.created_at })));
      if (data.length < 100) {
        return all;
      }
    }
  }

  async postReview(
    prNumber: number,
    refs: DiffRefs,
    summary: string,
    comments: InlineComment[]
  ): Promise<PostedComment[]> {
    await this.request(
      `/projects/${this.projectId}/merge_requests/${prNumber}/notes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: summary }),
      }
    );

    for (const comment of comments) {
      await this.request(
        `/projects/${this.projectId}/merge_requests/${prNumber}/discussions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: comment.body,
            position: {
              position_type: "text",
              base_sha: refs.baseSha,
              start_sha: refs.startSha,
              head_sha: refs.headSha,
              new_path: comment.path,
              new_line: comment.line,
            },
          }),
        }
      );
    }
    return [];
  }
}

export function createGitProvider(
  provider: string,
  config: ProviderConfig
): GitProvider {
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
