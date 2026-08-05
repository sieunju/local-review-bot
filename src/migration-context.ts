import { execFileSync } from "child_process";

export interface MigrationTarget {
  className: string;
  javaPath: string;
  kotlinPath: string;
  symbols: string[];
  signatures: string[];
}

const MAX_FILES = 6;
const MAX_SYMBOLS_PER_FILE = 12;
const MAX_HITS_PER_SYMBOL = 6;
const MAX_TOTAL_HITS = 60;
const GIT_MAX_BUFFER = 20 * 1024 * 1024;

// Override/lifecycle boilerplate that always exists 1:1 between Java and
// Kotlin versions of a class — never worth surfacing as a "new nullable API".
const NOISE_NAMES = new Set([
  "toString",
  "equals",
  "hashCode",
  "copy",
  "onCreate",
  "onDestroy",
  "onResume",
  "onPause",
  "onStart",
  "onStop",
  "onClick",
  "onAttach",
  "onDetach",
  "onViewCreated",
  "onCreateView",
  "onActivityCreated",
  "onLowMemory",
  "onSaveInstanceState",
  "onRestoreInstanceState",
  "onOptionsItemSelected",
  "onBindViewHolder",
  "onCreateViewHolder",
  "describeContents",
  "writeToParcel",
]);

function isNoiseName(name: string): boolean {
  return name.length <= 2 || NOISE_NAMES.has(name);
}

interface DiffBlock {
  oldPath?: string;
  newPath?: string;
  addedLines: string[];
}

function normalizePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "/dev/null") return undefined;
  return trimmed.replace(/^[ab]\//, "");
}

function basenameNoExt(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.(java|kt)$/, "");
}

function parseDiffBlocks(diff: string): DiffBlock[] {
  const rawBlocks = diff.split(/(?=^diff --git )/m).filter((b) => b.trim().length > 0);
  return rawBlocks.map((block) => {
    const oldMatch = block.match(/^--- (.+)$/m);
    const newMatch = block.match(/^\+\+\+ (.+)$/m);
    const addedLines = [...block.matchAll(/^\+(?!\+\+)(.*)$/gm)].map((m) => m[1]);
    return {
      oldPath: normalizePath(oldMatch?.[1]),
      newPath: normalizePath(newMatch?.[1]),
      addedLines,
    };
  });
}

function extractSymbols(addedLines: string[]): { symbols: string[]; signatures: string[] } {
  const symbols: string[] = [];
  const signatures: string[] = [];
  const seen = new Set<string>();

  for (const raw of addedLines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    if (/^(private|internal)\b/.test(line)) continue;

    // fun name(...) / fun <T> name(...)
    const funMatch = line.match(/\bfun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/);
    // val/var name: Type?
    const propMatch = line.match(/\b(?:val|var)\s+([A-Za-z_]\w*)\s*:\s*[\w.<>,\s]+\?/);

    const name = funMatch?.[1] ?? propMatch?.[1];
    if (!name || isNoiseName(name) || seen.has(name)) continue;

    seen.add(name);
    symbols.push(name);
    signatures.push(line);
  }

  return { symbols, signatures };
}

function buildTarget(javaPath: string, kotlinPath: string, addedLines: string[]): MigrationTarget {
  const { symbols, signatures } = extractSymbols(addedLines);
  return {
    className: basenameNoExt(kotlinPath),
    javaPath,
    kotlinPath,
    symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    signatures: signatures.slice(0, MAX_SYMBOLS_PER_FILE),
  };
}

/**
 * Scans a unified diff for Java→Kotlin file migrations:
 *  - Foo.java deleted + Foo.kt added (matched by basename)
 *  - Foo.java renamed to Foo.kt (single block, old/new both present)
 * and pulls the public symbols (functions, nullable properties) the Kotlin
 * side newly exposes, so callers elsewhere in the repo can be checked against
 * them even though those call sites never show up in the diff itself.
 */
export function detectJavaToKotlinMigrations(diff: string): MigrationTarget[] {
  const blocks = parseDiffBlocks(diff);
  const targets: MigrationTarget[] = [];

  // Case 1: rename in a single diff block (old .java -> new .kt).
  const matchedAdditionBlocks = new Set<DiffBlock>();
  for (const block of blocks) {
    if (block.oldPath?.endsWith(".java") && block.newPath?.endsWith(".kt")) {
      targets.push(buildTarget(block.oldPath, block.newPath, block.addedLines));
      matchedAdditionBlocks.add(block);
    }
  }

  // Case 2: separate delete (.java) + add (.kt) blocks matched by basename.
  const deletions = blocks.filter((b) => b.oldPath?.endsWith(".java") && !b.newPath);
  const additions = blocks.filter(
    (b) => b.newPath?.endsWith(".kt") && !b.oldPath && !matchedAdditionBlocks.has(b)
  );
  const usedAdditions = new Set<DiffBlock>();

  for (const del of deletions) {
    const javaPath = del.oldPath!;
    const stem = basenameNoExt(javaPath);
    const addition = additions.find(
      (a) => !usedAdditions.has(a) && basenameNoExt(a.newPath!) === stem
    );
    if (!addition) continue;
    usedAdditions.add(addition);
    targets.push(buildTarget(javaPath, addition.newPath!, addition.addedLines));
  }

  return targets.slice(0, MAX_FILES);
}

function gitGrep(repoPath: string, baseRef: string, symbol: string, excludePaths: string[]): string[] {
  const args = [
    "-C",
    repoPath,
    "grep",
    "-n",
    "-E",
    `(\\.|\\b)${symbol}\\s*(\\(|[^\\w(])`,
    baseRef,
    "--",
    "*.kt",
    "*.java",
    ...excludePaths.map((p) => `:(exclude)${p}`),
  ];
  try {
    const out = execFileSync("git", args, { maxBuffer: GIT_MAX_BUFFER, encoding: "utf-8" });
    return out.split("\n").filter((l) => l.length > 0);
  } catch {
    // git grep exits 1 when there are no matches — treat as "no hits".
    return [];
  }
}

function parseGrepHit(hitLine: string, baseRef: string): { path: string; line: number } | undefined {
  const prefix = `${baseRef}:`;
  const rest = hitLine.startsWith(prefix) ? hitLine.slice(prefix.length) : hitLine;
  const match = rest.match(/^(.+?):(\d+):/);
  if (!match) return undefined;
  return { path: match[1], line: Number(match[2]) };
}

function getFileLines(
  repoPath: string,
  baseRef: string,
  filePath: string,
  cache: Map<string, string[] | undefined>
): string[] | undefined {
  const key = `${baseRef}:${filePath}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const content = execFileSync("git", ["-C", repoPath, "show", key], {
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf-8",
    });
    const lines = content.split("\n");
    cache.set(key, lines);
    return lines;
  } catch {
    cache.set(key, undefined);
    return undefined;
  }
}

function buildSnippet(lines: string[], lineNum: number): string {
  const idx = lineNum - 1;
  const start = Math.max(0, idx - 4);
  const end = Math.min(lines.length - 1, idx + 4);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const marker = i === idx ? ">" : " ";
    const num = String(i + 1).padStart(4, " ");
    out.push(`${marker} ${num}  ${lines[i]}`);
  }
  return out.join("\n");
}

/**
 * For each migrated symbol, greps the base branch for call sites outside the
 * migrated files themselves and renders line-numbered snippets around each
 * hit. Returns "" (and never throws) whenever there's nothing useful to add —
 * no repo checkout, no targets, or no hits — so callers can splice the result
 * straight into a prompt without any conditional of their own.
 */
export function buildCallerContext(
  targets: MigrationTarget[],
  repoPath: string | undefined,
  baseRef: string
): string {
  if (!repoPath || targets.length === 0) return "";

  const fileCache = new Map<string, string[] | undefined>();
  const sections: string[] = [];
  let totalHits = 0;

  for (const target of targets) {
    if (totalHits >= MAX_TOTAL_HITS) break;
    const excludePaths = [target.javaPath, target.kotlinPath];
    const symbolBlocks: string[] = [];

    for (const symbol of target.symbols) {
      if (totalHits >= MAX_TOTAL_HITS) break;
      const hits = gitGrep(repoPath, baseRef, symbol, excludePaths);
      if (hits.length === 0) continue;

      const snippets: string[] = [];
      for (const hit of hits) {
        if (snippets.length >= MAX_HITS_PER_SYMBOL || totalHits >= MAX_TOTAL_HITS) break;
        const parsed = parseGrepHit(hit, baseRef);
        if (!parsed) continue;
        const lines = getFileLines(repoPath, baseRef, parsed.path, fileCache);
        if (!lines) continue;
        snippets.push(
          `\`${parsed.path}:${parsed.line}\`\n\`\`\`\n${buildSnippet(lines, parsed.line)}\n\`\`\``
        );
        totalHits++;
      }
      if (snippets.length > 0) {
        symbolBlocks.push(`**${symbol} 사용처:**\n\n${snippets.join("\n\n")}`);
      }
    }

    if (symbolBlocks.length > 0) {
      const sigList = target.signatures.map((s) => `- ${s}`).join("\n");
      sections.push(
        `### ${target.javaPath} → ${target.kotlinPath}\n\n시그니처:\n${sigList}\n\n${symbolBlocks.join("\n\n")}`
      );
    }
  }

  if (sections.length === 0) return "";

  return [
    "## Java→Kotlin 마이그레이션: 호출처 컨텍스트",
    "",
    "이 PR은 아래 클래스를 Java에서 Kotlin으로 마이그레이션합니다. base 브랜치 기준으로 이 클래스를 호출하는 코드를 찾아 스니펫으로 표시했습니다(diff에는 포함되지 않음). 시그니처 변경, 특히 nullable 여부가 호출부의 방어 코드(null 체크 등)와 맞는지 확인하세요.",
    "",
    ...sections,
  ].join("\n");
}
