import "dotenv/config";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { Agent, setGlobalDispatcher } from "undici";
import { createGitProvider, DiffRefs, GitProvider, InlineComment, PostedComment, ProjectConfig } from "./providers";
import { buildCallerContext, detectJavaToKotlinMigrations } from "./migration-context";
import { annotateDiff, normalizeCode, quotedLines, resolveLine, splitDiffByFile } from "./diff-lines";

interface Settings {
  llm: {
    // OpenAI-compatible base URL, e.g. "http://localhost:1234/v1"
    apiUrl: string;
    apiKey?: string;
    model: string;
    temperature?: number;
    timeoutMs?: number;
  };
  // Local-time window in which the polling loop reviews PRs, "HH:MM" each.
  // Omit to review around the clock. start > end means an overnight window.
  reviewHours?: { start: string; end: string };
  trigger?: {
    // "auto" (default): review every open PR. "manual": review a PR only
    // when someone comments the command on it.
    mode?: "auto" | "manual";
    // First word of the comment's first line, default "@review-bot".
    command?: string;
  };
}

function loadSettings(): Settings {
  const settingsPath = path.join(process.cwd(), "settings.json");
  if (!fs.existsSync(settingsPath)) {
    throw new Error("settings.json이 없습니다. settings.example.json을 복사해서 만들어 주세요.");
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Settings;
  if (!settings.llm?.apiUrl || !settings.llm?.model) {
    throw new Error("settings.json의 llm.apiUrl, llm.model은 필수입니다.");
  }
  return settings;
}

const settings = loadSettings();
const TRIGGER_MODE = settings.trigger?.mode ?? "auto";
const TRIGGER_COMMAND = settings.trigger?.command ?? "@review-bot";
if (TRIGGER_MODE !== "auto" && TRIGGER_MODE !== "manual") {
  throw new Error(`settings.json trigger.mode 값이 잘못됐습니다: "${TRIGGER_MODE}" (auto | manual)`);
}

// Node's built-in fetch is undici under the hood, and defaults to a 300s
// headersTimeout/bodyTimeout. generateReview() calls the LLM with
// stream:false, so it sends nothing — not even response headers — until
// generation is fully done. A large prompt (migration caller context can
// add tens of thousands of chars) or a slow local model can push that past
// 5 minutes, tripping undici's HeadersTimeoutError before the LLM ever gets
// to respond.
const LLM_TIMEOUT_MS = settings.llm.timeoutMs ?? 20 * 60_000;
setGlobalDispatcher(new Agent({ headersTimeout: LLM_TIMEOUT_MS, bodyTimeout: LLM_TIMEOUT_MS }));

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

const LLM_API_URL = settings.llm.apiUrl.replace(/\/+$/, "");
const LLM_TEMPERATURE = settings.llm.temperature ?? 0.2;
const REVIEW_INTERVAL = Number(process.env.REVIEW_INTERVAL ?? 300);
const REVIEW_LANGUAGE = process.env.REVIEW_LANGUAGE ?? "ko";
const REVIEW_LANGUAGE_NAMES: Record<string, string> = { ko: "Korean (한국어)", en: "English", ja: "Japanese (日本語)" };
const REVIEW_LANGUAGE_NAME = REVIEW_LANGUAGE_NAMES[REVIEW_LANGUAGE] ?? REVIEW_LANGUAGE;

// "owner/repo" -> local clone path, used to grep Java→Kotlin migration
// call sites on the base branch. See MIGRATION.md.
const REPO_PATHS: Record<string, string> = process.env.REPO_PATHS
  ? JSON.parse(process.env.REPO_PATHS)
  : {};
const FALLBACK_BASE_REF = process.env.BASE_REF ?? "origin/develop";

function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`settings.json reviewHours 값이 잘못됐습니다: "${value}" (HH:MM 형식)`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

const REVIEW_HOURS = settings.reviewHours
  ? { start: parseClock(settings.reviewHours.start), end: parseClock(settings.reviewHours.end) }
  : undefined;

function isWithinReviewHours(now: Date): boolean {
  if (!REVIEW_HOURS) {
    return true;
  }
  const minutes = now.getHours() * 60 + now.getMinutes();
  const { start, end } = REVIEW_HOURS;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// DiffRefs only guarantees `baseSha` today, but provider implementations
// have used different field names historically — check the real field first,
// then a few likely aliases, before giving up and falling back.
function resolveBaseRef(refs: DiffRefs): string {
  const candidates = refs as unknown as Record<string, unknown>;
  const candidate =
    candidates.baseSha ?? candidates.base ?? candidates.baseCommitSha ?? candidates.baseRef;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : FALLBACK_BASE_REF;
}

function refreshRepo(repoPath: string): void {
  try {
    execFileSync("git", ["-C", repoPath, "fetch", "--all", "--prune", "--quiet"], {
      stdio: "ignore",
    });
  } catch (err) {
    console.warn(`⚠️  git fetch 실패 (${repoPath}): ${(err as Error).message}`);
  }
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
db.exec(`
  CREATE TABLE IF NOT EXISTS pr_triggers (
    project TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    last_comment_id INTEGER NOT NULL,
    PRIMARY KEY (project, pr_number)
  )
`);
db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

// Manual mode only reacts to commands commented after the bot was first
// started in manual mode, so old comments on existing PRs don't fire.
function getManualStartedAt(): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'manual_started_at'").get() as
    | { value: string }
    | undefined;
  if (row) {
    return Date.parse(row.value);
  }
  const now = new Date();
  db.prepare("INSERT INTO meta (key, value) VALUES ('manual_started_at', ?)").run(now.toISOString());
  return now.getTime();
}
const MANUAL_STARTED_AT = TRIGGER_MODE === "manual" ? getManualStartedAt() : 0;

function isTriggerCommand(body: string): boolean {
  const firstLine = body.trim().split("\n")[0] ?? "";
  return firstLine.trim().split(/\s+/)[0] === TRIGGER_COMMAND;
}

// Returns true if a new, not-yet-handled command comment exists on the PR.
// The high-water mark is saved before the review runs, so a crash mid-review
// doesn't re-run the same command on restart.
async function consumeTrigger(project: Project, prNumber: number): Promise<boolean> {
  const row = db
    .prepare("SELECT last_comment_id FROM pr_triggers WHERE project = ? AND pr_number = ?")
    .get(project.label, prNumber) as { last_comment_id: number } | undefined;
  const lastSeen = row?.last_comment_id ?? 0;
  const fresh = (await project.provider.fetchComments(prNumber)).filter(
    (c) => c.id > lastSeen && Date.parse(c.createdAt) >= MANUAL_STARTED_AT
  );
  if (fresh.length === 0) {
    return false;
  }
  db.prepare(
    "INSERT OR REPLACE INTO pr_triggers (project, pr_number, last_comment_id) VALUES (?, ?, ?)"
  ).run(project.label, prNumber, Math.max(...fresh.map((c) => c.id)));
  return fresh.some((c) => isTriggerCommand(c.body));
}

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
  const guideFile = `CLAUDE_${stack.toUpperCase()}.md`;
  const referenceFile = `REFERENCE_${stack.toUpperCase()}.md`;
  const guide = readIfExists(guideFile);
  const reference = readIfExists(referenceFile);
  return reference ? `${guide}\n\n---\n\n${reference}` : guide;
}

interface ParsedReview {
  summary: string;
  comments: InlineComment[];
}

// A comment as parsed from the LLM, before the code snippet is attached.
interface DraftComment extends InlineComment {
  code?: string;
}

const CODE_INSTRUCTIONS = `Every item must also include "code": the 2-6 consecutive lines of the problematic code, copied character-for-character from the diff's added lines (without the "L<number> +" prefix), with "\\n" between lines. It must contain the line that "line" points to. Do not paraphrase, reformat or shorten the code.`;

const LINE_NUMBER_INSTRUCTIONS = `Each line is prefixed with its new-file line number (e.g. \`L42 + code\`). Copy the line number from the prefix. Never compute or guess it. Added lines look like \`L42 + code\`, unchanged context lines like \`L42   code\`, and removed lines have no number. "line" must be the number from the prefix of an added line.`;

const REVIEW_JSON_INSTRUCTIONS = `
Respond with ONLY valid JSON (no markdown fences, no extra text) in this exact shape:
{
  "summary": "one-line overall summary",
  "comments": [
    { "file": "path/to/File.kt", "line": 42, "code": "val user = repo.find(id)!!\\nshow(user.name)", "body": "review comment for this line" }
  ]
}
${LINE_NUMBER_INSTRUCTIONS}
${CODE_INSTRUCTIONS}
IMPORTANT: write "summary" and every comment "body" in ${REVIEW_LANGUAGE_NAME}, regardless of what language the guide or diff above is in.
`;

// For guides that define their own {"findings":[...]} output schema
// (e.g. CLAUDE_ANDROID.md): keep the guide's shape, only add line/language rules.
const FINDINGS_JSON_INSTRUCTIONS = `
Respond with ONLY valid JSON (no markdown fences, no extra text) in the {"findings":[...]} shape defined in the guide above.
${LINE_NUMBER_INSTRUCTIONS}
${CODE_INSTRUCTIONS}
IMPORTANT: write "reasoning", "issue" and "fix" in ${REVIEW_LANGUAGE_NAME}, regardless of what language the guide or diff above is in.
`;

const MIN_FINDING_CONFIDENCE = 0.8;

interface Finding {
  file: string;
  line: number;
  code?: string;
  severity?: string;
  issue: string;
  fix?: string;
  confidence?: number;
}

function findingsToReview(findings: Finding[]): { summary: string; comments: DraftComment[] } {
  const kept = findings.filter((f) => (f.confidence ?? 1) >= MIN_FINDING_CONFIDENCE);
  const count = (severity: string) => kept.filter((f) => f.severity === severity).length;
  return {
    summary: `MUST ${count("MUST")} · SHOULD ${count("SHOULD")}`,
    comments: kept.map((f) => ({
      path: f.file,
      line: f.line,
      code: f.code,
      body: `**[${f.severity ?? "SHOULD"}]** ${f.issue}` + (f.fix ? `\n\n**Fix:** ${f.fix}` : ""),
    })),
  };
}

function parseReview(raw: string): { summary: string; comments: DraftComment[] } {
  const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(jsonText) as {
      summary?: string;
      comments?: Array<{ file: string; line: number; code?: string; body: string }>;
      findings?: Finding[];
    };
    if (Array.isArray(parsed.findings)) {
      return findingsToReview(parsed.findings);
    }
    return {
      summary: parsed.summary ?? "",
      comments: (parsed.comments ?? []).map((c) => ({
        path: c.file,
        line: c.line,
        code: c.code,
        body: c.body,
      })),
    };
  } catch {
    return { summary: raw, comments: [] };
  }
}

const SNIPPET_MAX_LINES = 6;

const FENCE_LANGUAGES: Record<string, string> = {
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  xml: "xml",
  gradle: "groovy",
  swift: "swift",
  m: "objectivec",
  h: "objectivec",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  vue: "vue",
};

// Picks the [start, end] new-file line range to show for a comment anchored
// at `line`: the quoted block around it (up to SNIPPET_MAX_LINES), limited to
// lines that are contiguous in the diff.
function snippetRange(lines: Map<number, string>, line: number, code: string | undefined): [number, number] {
  const quoted = quotedLines(code);
  const offset = Math.max(0, quoted.indexOf(normalizeCode(lines.get(line) ?? "")));
  let start = line - Math.min(offset, SNIPPET_MAX_LINES - 1);
  let end = start + Math.min(Math.max(quoted.length, 1), SNIPPET_MAX_LINES) - 1;
  // A single line alone is hard to place — show one line of context each side.
  if (start === end) {
    start--;
    end++;
  }
  let from = line;
  let to = line;
  while (from > start && lines.has(from - 1)) from--;
  while (to < end && lines.has(to + 1)) to++;
  return [from, to];
}

// Verifies each comment's line against the code the LLM quoted (correcting
// it when the code is found elsewhere), prefixes the body with a fenced
// snippet taken from the diff itself, and moves comments that can't be
// placed on an added line into the summary.
function attachSnippets(review: { summary: string; comments: DraftComment[] }, diff: string): ParsedReview {
  const patches = splitDiffByFile(diff);
  const comments: InlineComment[] = [];
  let summary = review.summary;
  for (const { code, ...comment } of review.comments) {
    const patch = patches.get(comment.path);
    const file = patch === undefined ? undefined : annotateDiff(patch);
    const line = file && resolveLine({ line: comment.line, code }, file.added);
    if (!file || line === undefined) {
      const reason = !file ? "diff에 없는 파일" : "code가 추가된 줄과 일치하지 않음";
      console.warn(`⚠️  ${comment.path}:${comment.line} 인라인 불가 → 요약으로 이동 (${reason})`);
      summary += `\n\n---\n\`${comment.path}\`\n\n${comment.body}`;
      continue;
    }
    if (line !== comment.line) {
      console.log(`🔧 ${comment.path}: 줄 번호 교정 ${comment.line} → ${line} (code 일치 위치 기준)`);
    }
    const [start, end] = snippetRange(file.lines, line, code);
    const snippet: string[] = [];
    for (let n = start; n <= end; n++) {
      snippet.push(file.lines.get(n)!);
    }
    const indent = Math.min(...snippet.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const location = start === end ? `${start}` : `${start}-${end}`;
    const language = FENCE_LANGUAGES[comment.path.split(".").pop() ?? ""] ?? "";
    comments.push({
      ...comment,
      line,
      body:
        `\`\`\`${language}\n${snippet.map((l) => l.slice(indent)).join("\n")}\n\`\`\`\n` +
        `\`${comment.path}:${location}\`\n\n${comment.body}`,
    });
  }
  return { summary, comments };
}

async function generateReview(diff: string, stack: string, callerContext: string): Promise<ParsedReview> {
  const guide = loadReviewGuide(stack);
  const stackLabel = STACK_LABELS[stack];

  // Only pull in the migration review guide (and pay its context cost) on
  // PRs where we actually found caller context to check it against.
  const migrationGuide = callerContext ? readIfExists("MIGRATION.md") : "";
  const systemParts = [`You are a ${stackLabel} code reviewer. Follow this team's review guide:\n\n${guide}`];
  if (migrationGuide) {
    systemParts.push(migrationGuide);
  }
  if (guide.includes('"findings"')) {
    systemParts.push(FINDINGS_JSON_INSTRUCTIONS);
  } else {
    systemParts.push(`Write the "summary" and all comment "body" text in ${REVIEW_LANGUAGE_NAME}.`);
    systemParts.push(REVIEW_JSON_INSTRUCTIONS);
  }

  // The LLM sees every line prefixed with its new-file line number.
  const numberedDiff = [...splitDiffByFile(diff).values()].map((patch) => annotateDiff(patch).text).join("\n");
  const userContent = callerContext
    ? `${callerContext}\n\n=== DIFF (리뷰 대상 — 코멘트는 이 안의 파일/라인에만 달 수 있음) ===\n${numberedDiff}`
    : `Review the following diff and leave concise, actionable feedback:\n\n${numberedDiff}`;

  const res = await fetch(`${LLM_API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(settings.llm.apiKey ? { Authorization: `Bearer ${settings.llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.llm.model,
      stream: false,
      temperature: LLM_TEMPERATURE,
      messages: [
        {
          role: "system",
          content: systemParts.join("\n\n"),
        },
        {
          role: "user",
          content: userContent,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM API error: ${res.status}`);
  }
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number };
  };
  const content = data.choices[0].message.content;
  console.log(`🤖 LLM 응답:\n${content}`);
  if (typeof data.usage?.prompt_tokens === "number") {
    console.log(`📊 prompt tokens: ${data.usage.prompt_tokens}`);
  }
  return attachSnippets(parseReview(content), diff);
}

async function reviewProject(project: Project): Promise<void> {
  const { label, provider, stack } = project;
  const prs = await provider.fetchOpenPullRequests();
  console.log(`\n📋 [${new Date().toLocaleTimeString()}] [${label}] 오픈 PR 확인: ${prs.length}개`);

  for (const pr of prs) {
    if (TRIGGER_MODE === "manual") {
      if (!(await consumeTrigger(project, pr.number))) {
        continue;
      }
      console.log(`💬 [${label}] PR #${pr.number}: ${TRIGGER_COMMAND} 명령 감지`);
    }
    const refs = await provider.fetchDiffRefs(pr.number);
    // A manual command always re-reviews, even if the head commit is unchanged.
    if (TRIGGER_MODE === "auto" && isAlreadyReviewed(label, pr.number, refs.headSha)) {
      console.log(`⏭️  [${label}] PR #${pr.number}: 이미 리뷰됨 (변경 없음)`);
      continue;
    }

    const diff = await provider.fetchDiff(pr.number);
    if (!isRelevantPullRequest(diff, stack)) {
      console.log(`⏭️  [${label}] PR #${pr.number}: ${STACK_LABELS[stack]} 관련 아님`);
      continue;
    }

    const reviewStartedAt = Date.now();
    console.log(
      `🔍 [${label}] PR #${pr.number} 리뷰 시작 (${new Date(reviewStartedAt).toLocaleTimeString()}): "${pr.title}"`
    );
    const previousComments = getUnresolvedComments(label, pr.number);

    let callerContext = "";
    if (stack === "android") {
      const migrations = detectJavaToKotlinMigrations(diff);
      if (migrations.length > 0) {
        const repoPath = REPO_PATHS[label];
        const classNames = migrations.map((m) => m.className).join(", ");
        if (!repoPath) {
          console.warn(
            `⚠️  [${label}] PR #${pr.number}: 마이그레이션 감지됨(${classNames})이지만 REPO_PATHS에 로컬 클론 경로가 없어 호출처 컨텍스트를 건너뜁니다`
          );
        } else {
          refreshRepo(repoPath);
          callerContext = buildCallerContext(migrations, repoPath, resolveBaseRef(refs));
          console.log(
            `🔀 [${label}] PR #${pr.number}: 마이그레이션 ${migrations.length}건 (${classNames}) → 호출처 컨텍스트 ${callerContext.length}자`
          );
        }
      }
    }

    const review = await generateReview(diff, stack, callerContext);
    const posted = await provider.postReview(pr.number, refs, review.summary, review.comments);
    markReviewed(label, pr.number, refs.headSha);
    storeComments(label, pr.number, posted);
    const takeTime = ((Date.now() - reviewStartedAt) / 1000).toFixed(1);
    console.log(
      `✅ [${label}] PR #${pr.number}에 리뷰 등록됨 (인라인 코멘트 ${review.comments.length}개, takeTime ${takeTime}s)`
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
    console.log(
      TRIGGER_MODE === "manual"
        ? `🎯 수동 모드: PR에 "${TRIGGER_COMMAND}" 코멘트가 달리면 리뷰`
        : "🎯 자동 모드: 오픈 PR 전부 리뷰"
    );
    if (settings.reviewHours) {
      console.log(`🕘 리뷰 시간대: ${settings.reviewHours.start} ~ ${settings.reviewHours.end}`);
    }
  }

  // --once is a manual run, so it ignores the review-hours window.
  if (once) {
    await reviewOpenPullRequests();
    return;
  }

  const tick = async (): Promise<void> => {
    if (!isWithinReviewHours(new Date())) {
      console.log(`💤 [${new Date().toLocaleTimeString()}] 리뷰 시간대가 아니라 건너뜀`);
      return;
    }
    await reviewOpenPullRequests();
  };

  await tick();
  setInterval(() => {
    tick().catch((err) => console.error(err));
  }, REVIEW_INTERVAL * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
