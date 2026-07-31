import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { createGitProvider } from "./providers";

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

async function generateReview(diff: string): Promise<string> {
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
          content: `You are an Android code reviewer. Follow this team's review guide:\n\n${guide}`,
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
  return data.message.content;
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
    await gitProvider.postComment(pr.number, review);
    markReviewed(pr.number);
    console.log(`✅ PR #${pr.number}에 리뷰 댓글 추가됨`);
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
