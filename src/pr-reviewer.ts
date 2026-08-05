import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { Agent, setGlobalDispatcher } from "undici";
import { createGitProvider, GitProvider, InlineComment, PostedComment, ProjectConfig } from "./providers";

// Node's built-in fetch is undici under the hood, and defaults to a 300s
// headersTimeout/bodyTimeout. generateReview() calls Ollama with
// stream:false, so it sends nothing — not even response headers — until
// generation is fully done. A large num_ctx or a slow local model can push
// that past 5 minutes, tripping undici's HeadersTimeoutError before Ollama
// ever gets to respond.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 20 * 60_000);
setGlobalDispatcher(new Agent({ headersTimeout: OLLAMA_TIMEOUT_MS, bodyTimeout: OLLAMA_TIMEOUT_MS }));

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
      stack: process.env.STACK ?? "android",
    },
  ];
}

interface Project {
  label: string;
  provider: GitProvider;
  stack: string;
}

const STACK_MARKERS: Record<string, string[]> = {
  android: [".kt", ".java", "build.gradle", "build.gradle.kts"],
  ios: [".swift", ".m", ".h", "Podfile", ".xcodeproj", ".pbxproj"],
  web: [".ts", ".tsx", ".js", ".jsx", ".vue", "package.json"],
};

const STACK_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  web: "Web frontend",
};

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
const REVIEW_INTERVAL = Number(process.env.REVIEW_INTERVAL ?? 300);
const REVIEW_LANGUAGE = process.env.REVIEW_LANGUAGE ?? "ko";
const REVIEW_LANGUAGE_NAMES: Record<string, string> = { ko: "Korean (한국어)", en: "English", ja: "Japanese (日本語)" };
const REVIEW_LANGUAGE_NAME = REVIEW_LANGUAGE_NAMES[REVIEW_LANGUAGE] ?? REVIEW_LANGUAGE;

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
db.exec(`
  CREATE TABLE IF NOT EXISTS review_comments (
    project TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    comment_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project, comment_id)
  )
`);

const projects: Project[] = loadProjects().map((cfg) => {
  const provider = cfg.provider.toLowerCase();
  const stack = (cfg.stack ?? "android").toLowerCase();
  if (!STACK_MARKERS[stack]) {
    throw new Error(`Unknown stack "${stack}" for ${cfg.owner}/${cfg.repo}. Supported: ${Object.keys(STACK_MARKERS).join(", ")}`);
  }
  return {
    label: `${cfg.owner}/${cfg.repo}`,
    provider: createGitProvider(provider, {
      url: cfg.url ?? DEFAULT_URLS[provider],
      token: cfg.token,
      owner: cfg.owner,
      repo: cfg.repo,
    }),
    stack,
  };
});

function isRelevantPullRequest(diff: string, stack: string): boolean {
  return STACK_MARKERS[stack].some((marker) => diff.includes(marker));
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

interface StoredComment {
  comment_id: number;
  path: string;
  line: number;
}

function getUnresolvedComments(project: string, prNumber: number): StoredComment[] {
  return db
    .prepare(
      "SELECT comment_id, path, line FROM review_comments WHERE project = ? AND pr_number = ? AND resolved = 0"
    )
    .all(project, prNumber) as StoredComment[];
}

function storeComments(project: string, prNumber: number, comments: PostedComment[]): void {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO review_comments (project, pr_number, comment_id, path, line, resolved) VALUES (?, ?, ?, ?, ?, 0)"
  );
  for (const c of comments) {
    insert.run(project, prNumber, c.id, c.path, c.line);
  }
}

function markCommentsResolved(project: string, commentIds: number[]): void {
  const update = db.prepare(
    "UPDATE review_comments SET resolved = 1 WHERE project = ? AND comment_id = ?"
  );
  for (const id of commentIds) {
    update.run(project, id);
  }
}

function parseDiffFiles(diff: string): Set<string> {
  const files = new Set<string>();
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    files.add(match[1]);
  }
  return files;
}

function readIfExists(fileName: string): string {
  const filePath = path.join(process.cwd(), fileName);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function loadReviewGuide(stack: string): string {
  const guideFile = stack === "android" ? "CLAUDE.md" : `CLAUDE_${stack.toUpperCase()}.md`;
  const referenceFile = stack === "android" ? "REFERENCE.md" : `REFERENCE_${stack.toUpperCase()}.md`;
  const guide = readIfExists(guideFile);
  const reference = readIfExists(referenceFile);
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
"line" must be the line number in the NEW version of the file (as shown in the diff's + lines). Calculate it from the hunk header "@@ -oldStart,oldCount +newStart,newCount @@": newStart + L, where L is the number of lines (added AND unchanged context lines, but NOT removed "-" lines) counted from the first line after that header down to the line you want to comment on (the first line after the header is L=0). Recompute newStart from each new "@@" header you cross. Omit comments you are not confident about the line number for.
IMPORTANT: write "summary" and every comment "body" in ${REVIEW_LANGUAGE_NAME}, regardless of what language the guide or diff above is in.
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

async function generateReview(diff: string, stack: string): Promise<ParsedReview> {
  const guide = loadReviewGuide(stack);
  const stackLabel = STACK_LABELS[stack];
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content: `You are a ${stackLabel} code reviewer. Follow this team's review guide:\n\n${guide}\n\nWrite the "summary" and all comment "body" text in ${REVIEW_LANGUAGE_NAME}.\n\n${REVIEW_JSON_INSTRUCTIONS}`,
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
  console.log(`🤖 Ollama 응답:\n${data.message.content}`);
  return parseReview(data.message.content);
}

async function reviewProject(project: Project): Promise<void> {
  const { label, provider, stack } = project;
  const prs = await provider.fetchOpenPullRequests();
  console.log(`\n📋 [${new Date().toLocaleTimeString()}] [${label}] 오픈 PR 확인: ${prs.length}개`);

  for (const pr of prs) {
    const refs = await provider.fetchDiffRefs(pr.number);
    if (isAlreadyReviewed(label, pr.number, refs.headSha)) {
      console.log(`⏭️  [${label}] PR #${pr.number}: 이미 리뷰됨 (변경 없음)`);
      continue;
    }

    const diff = await provider.fetchDiff(pr.number);
    if (!isRelevantPullRequest(diff, stack)) {
      console.log(`⏭️  [${label}] PR #${pr.number}: ${STACK_LABELS[stack]} 관련 아님`);
      continue;
    }

    console.log(`🔍 [${label}] PR #${pr.number} 리뷰 시작: "${pr.title}"`);
    const previousComments = getUnresolvedComments(label, pr.number);
    const review = await generateReview(diff, stack);
    const posted = await provider.postReview(pr.number, refs, review.summary, review.comments);
    markReviewed(label, pr.number, refs.headSha);
    storeComments(label, pr.number, posted);
    console.log(
      `✅ [${label}] PR #${pr.number}에 리뷰 등록됨 (인라인 코멘트 ${review.comments.length}개)`
    );

    if (provider.resolveComments && previousComments.length > 0) {
      const touchedFiles = parseDiffFiles(diff);
      const stillFlagged = new Set(review.comments.map((c) => `${c.path}:${c.line}`));
      const toResolve = previousComments.filter(
        (c) => touchedFiles.has(c.path) && !stillFlagged.has(`${c.path}:${c.line}`)
      );
      if (toResolve.length > 0) {
        await provider.resolveComments(toResolve.map((c) => c.comment_id));
        markCommentsResolved(label, toResolve.map((c) => c.comment_id));
        console.log(`✅ [${label}] PR #${pr.number}: 코멘트 ${toResolve.length}개 resolve 처리`);
      }
    }
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
