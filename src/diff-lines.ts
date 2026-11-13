// Line-number handling for review comments. Local LLMs are unreliable at
// computing new-file line numbers from hunk headers, so the bot prints the
// number on every diff line (annotateDiff) and then verifies what the LLM
// sent back against the diff (resolveLine).

export interface AnnotatedDiff {
  // The patch with every line prefixed by its new-file line number.
  text: string;
  // New-file line number -> code, added ("+") lines only.
  added: Map<number, string>;
  // New-file line number -> code, added and context lines.
  lines: Map<number, string>;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Annotates a single file's patch (file headers optional). Works on any
// subset of a file's hunks, since numbering restarts from each hunk header.
export function annotateDiff(patch: string): AnnotatedDiff {
  const added = new Map<number, string>();
  const lines = new Map<number, string>();
  const out: string[] = [];
  let newLine = 0;
  // Lines still expected in the current hunk, per its header. Counting them
  // (rather than sniffing prefixes) keeps a removed line like "--- x" or an
  // added line like "+++ x" from being mistaken for a file header.
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    }
    // Hunk content always starts with " ", "+" or "-", so a "@@" line is a
    // new hunk header even if the previous header's counts were off.
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLine = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
      out.push(line);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      out.push(line); // file header or other metadata: as-is
      continue;
    }
    const code = line.slice(1);
    if (line.startsWith("-")) {
      out.push(`     - ${code}`);
      oldLeft--;
    } else if (line.startsWith("+")) {
      out.push(`L${newLine} + ${code}`);
      added.set(newLine, code);
      lines.set(newLine, code);
      newLine++;
      newLeft--;
    } else {
      out.push(`L${newLine}   ${code}`);
      lines.set(newLine, code);
      newLine++;
      oldLeft--;
      newLeft--;
    }
  }
  return { text: out.join("\n"), added, lines };
}

// Splits a multi-file unified diff into per-file patches, keyed by new path.
export function splitDiffByFile(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const patch of diff.split(/^(?=diff --git )/m)) {
    const path = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? /^diff --git a\/.+ b\/(.+)$/m.exec(patch)?.[1];
    if (path) {
      files.set(path, patch);
    }
  }
  return files;
}

// Strips indentation and any diff prefix the LLM copied along with the code
// ("+ code" or "L42 + code"), so quoted and actual lines compare equal.
export function normalizeCode(line: string): string {
  return line
    .trim()
    .replace(/^(?:L\d+\s*)?\+\s*/, "")
    .trim();
}

export function quotedLines(code: string | undefined): string[] {
  return (code ?? "")
    .split("\n")
    .map(normalizeCode)
    .filter((l) => l.length > 0);
}

// Verifies the LLM's line against the code it quoted. Returns the line to
// comment on — the original if the added line there matches the quoted code,
// otherwise the nearest added line that does — or undefined if the quoted
// code matches no added line (the finding can't be placed inline).
// "code" may be several lines; a line matches if it equals any of them.
export function resolveLine(
  finding: { line: number; code?: string },
  added: Map<number, string>
): number | undefined {
  const quoted = new Set(quotedLines(finding.code));
  const matches = (lineNo: number): boolean => quoted.has(normalizeCode(added.get(lineNo) ?? ""));
  if (added.has(finding.line) && matches(finding.line)) {
    return finding.line;
  }
  let best: number | undefined;
  for (const lineNo of added.keys()) {
    if (matches(lineNo) && (best === undefined || Math.abs(lineNo - finding.line) < Math.abs(best - finding.line))) {
      best = lineNo;
    }
  }
  return best;
}
