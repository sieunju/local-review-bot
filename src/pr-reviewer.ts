import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { createGitProvider, GitProvider, InlineComment, ProjectConfig } from "./providers";

const DEFAULT_URLS: Record<string, string> = {
  gitea: "http://localhost:3000",
  github: "https://api.github.com",
  gitlab: "https://gitlab.com",
};

function loadProjects(): ProjectConfig[] {
  const reposJson = process.env.REPOS;
  if (reposJson) {
    return JSON.parse(reposJson) as ProjectConfig[];
  }
  return [
    {
      provider: process.env.GIT_PROVIDER ?? "gitea",
      url: process.env.GIT_URL,
      token: requireEnv("GIT_TOKEN"),
      owner: requireEnv("REPO_OWNER"),
      repo: requireEnv("REPO_NAME"),
    },
  ];
}

interface Project {
  label: string;
  provider: GitProvider;
}

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
const REVIEW_INTERVAL = Number(process.env.REVIEW_INTERVAL ?? 300);
const REVIEW_LANGUAGE = process.env.REVIEW_LANGUAGE ?? "ko";

const ANDROID_MARKERS = [".kt", ".java", "build.gradle", "build.gradle.kts"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const db = new Database(path.join(process.cwd(), "pr-reviewer.db"));
const reviewedPrsColumns = db
  .prepare("PRAGMA table_info(reviewed_prs)")
  .all() as Array<{ name: string }>;
if (reviewedPrsColumns.length > 0 && !reviewedPrsColumns.some((c) => c.name === "project")) {
  db.exec("DROP TABLE reviewed_prs");
}
db.exec(`
  CREATE TABLE IF NOT EXISTS reviewed_prs (
    project TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL,
    head_sha TEXT,
    PRIMARY KEY (project, pr_number)
  )
`);

const projects: Project[] = loadProjects().map((cfg) => {
  const provider = cfg.provider.toLowerCase();
  return {
    label: `${cfg.owner}/${cfg.repo}`,
    provider: createGitProvider(provider, {
      url: cfg.url ?? DEFAULT_URLS[provider],
      token: cfg.token,
      owner: cfg.owner,
      repo: cfg.repo,
    }),
  };
});

function isAndroidPullRequest(diff: string): boolean {
  return ANDROID_MARKERS.some((marker) => diff.includes(marker));
}

function isAlreadyReviewed(project: string, prNumber: number, headSha: string): boolean {
  const row = db
    .prepare("SELECT head_sha FROM reviewed_prs WHERE project = ? AND pr_number = ?")
    .get(project, prNumber) as { head_sha: string } | undefined;
  return row !== undefined && row.head_sha === headSha;
}

function markReviewed(project: string, prNumber: number, headSha: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO reviewed_prs (project, pr_number, reviewed_at, head_sha) VALUES (?, ?, ?, ?)"
  ).run(project, prNumber, new Date().toISOString(), headSha);
}

function readIfExists(fileName: string): string {
  const filePath = path.join(process.cwd(), fileName);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function loadReviewGuide(): string {
  const guide = readIfExists("CLAUDE.md");
  const reference = readIfExists("REFERENCE.md");
  return reference ? `${guide}\n\n---\n\n${reference}` : guide;
}

interface ParsedReview {
  summary: string;
  comments: InlineComment[];
}

const REVIEW_JSON_INSTRUCTIONS = `
Respond with ONLY valid JSON (no markdown fences, no extra text) in this exact shape:
{
  "summary": "one-line overall summary",
  "comments": [
    { "file": "path/to/File.kt", "line": 42, "body": "review comment for this line" }
  ]
}
"line" must be the line number in the NEW version of the file (as shown in the diff's + lines). Omit comments you are not confident about the line number for.
`;

function parseReview(raw: string): ParsedReview {
  const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(jsonText) as {
      summary?: string;
      comments?: Array<{ file: string; line: number; body: string }>;
    };
    return {
      summary: parsed.summary ?? "",
      comments: (parsed.comments ?? []).map((c) => ({
        path: c.file,
        line: c.line,
        body: c.body,
      })),
    };
  } catch {
    return { summary: raw, comments: [] };
  }
}

async function generateReview(diff: string): Promise<ParsedReview> {
  const guide = loadReviewGuide();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content: `You are an Android code reviewer. Follow this team's review guide:\n\n${guide}\n\nWrite the "summary" and all comment "body" text in ${REVIEW_LANGUAGE}.\n\n${REVIEW_JSON_INSTRUCTIONS}`,
        },
        {
          role: "user",
          content: `Review the following diff and leave concise, actionable feedback:\n\n${diff}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status}`);
  }
  const data = (await res.json()) as { message: { content: string } };
  return parseReview(data.message.content);
}

async function reviewProject(project: Project): Promise<void> {
  const { label, provider } = project;
  const prs = await provider.fetchOpenPullRequests();
  console.log(`\n📋 [${new Date().toLocaleTimeString()}] [${label}] 오픈 PR 확인: ${prs.length}개`);

  for (const pr of prs) {
    const refs = await provider.fetchDiffRefs(pr.number);
    if (isAlreadyReviewed(label, pr.number, refs.headSha)) {
      console.log(`⏭️  [${label}] PR #${pr.number}: 이미 리뷰됨 (변경 없음)`);
      continue;
    }

    const diff = await provider.fetchDiff(pr.number);
    if (!isAndroidPullRequest(diff)) {
      console.log(`⏭️  [${label}] PR #${pr.number}: Android 관련 아님`);
      continue;
    }

    console.log(`🔍 [${label}] PR #${pr.number} 리뷰 시작: "${pr.title}"`);
    const review = await generateReview(diff);
    await provider.postReview(pr.number, refs, review.summary, review.comments);
    markReviewed(label, pr.number, refs.headSha);
    console.log(
      `✅ [${label}] PR #${pr.number}에 리뷰 등록됨 (인라인 코멘트 ${review.comments.length}개)`
    );
  }
}

async function reviewOpenPullRequests(): Promise<void> {
  for (const project of projects) {
    await reviewProject(project);
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");

  console.log("🚀 PR 리뷰 에이전트 시작");
  if (!once) {
    console.log(`⏰ 체크 간격: ${REVIEW_INTERVAL}초`);
  }

  await reviewOpenPullRequests();

  if (!once) {
    setInterval(() => {
      reviewOpenPullRequests().catch((err) => console.error(err));
    }, REVIEW_INTERVAL * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
