import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { createGitProvider, InlineComment } from "./providers";

const DEFAULT_URLS: Record<string, string> = {
  gitea: "http://localhost:3000",
  github: "https://api.github.com",
  gitlab: "https://gitlab.com",
};

const GIT_PROVIDER = (process.env.GIT_PROVIDER ?? "gitea").toLowerCase();
const GIT_URL = process.env.GIT_URL ?? DEFAULT_URLS[GIT_PROVIDER];
const GIT_TOKEN = requireEnv("GIT_TOKEN");
const REPO_OWNER = requireEnv("REPO_OWNER");
const REPO_NAME = requireEnv("REPO_NAME");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
const REVIEW_INTERVAL = Number(process.env.REVIEW_INTERVAL ?? 300);

const ANDROID_MARKERS = [".kt", ".java", "build.gradle", "build.gradle.kts"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const db = new Database(path.join(process.cwd(), "pr-reviewer.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS reviewed_prs (
    pr_number INTEGER PRIMARY KEY,
    reviewed_at TEXT NOT NULL
  )
`);

const gitProvider = createGitProvider({
  url: GIT_URL,
  token: GIT_TOKEN,
  owner: REPO_OWNER,
  repo: REPO_NAME,
});

function isAndroidPullRequest(diff: string): boolean {
  return ANDROID_MARKERS.some((marker) => diff.includes(marker));
}

function isAlreadyReviewed(prNumber: number): boolean {
  const row = db
    .prepare("SELECT 1 FROM reviewed_prs WHERE pr_number = ?")
    .get(prNumber);
  return row !== undefined;
}

function markReviewed(prNumber: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO reviewed_prs (pr_number, reviewed_at) VALUES (?, ?)"
  ).run(prNumber, new Date().toISOString());
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
          content: `You are an Android code reviewer. Follow this team's review guide:\n\n${guide}\n\n${REVIEW_JSON_INSTRUCTIONS}`,
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

async function reviewOpenPullRequests(): Promise<void> {
  const prs = await gitProvider.fetchOpenPullRequests();
  console.log(`\n📋 [${new Date().toLocaleTimeString()}] 오픈 PR 확인: ${prs.length}개`);

  for (const pr of prs) {
    if (isAlreadyReviewed(pr.number)) {
      console.log(`⏭️  PR #${pr.number}: 이미 리뷰됨`);
      continue;
    }

    const diff = await gitProvider.fetchDiff(pr.number);
    if (!isAndroidPullRequest(diff)) {
      console.log(`⏭️  PR #${pr.number}: Android 관련 아님`);
      continue;
    }

    console.log(`🔍 PR #${pr.number} 리뷰 시작: "${pr.title}"`);
    const review = await generateReview(diff);
    const refs = await gitProvider.fetchDiffRefs(pr.number);
    await gitProvider.postReview(pr.number, refs, review.summary, review.comments);
    markReviewed(pr.number);
    console.log(
      `✅ PR #${pr.number}에 리뷰 등록됨 (인라인 코멘트 ${review.comments.length}개)`
    );
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
