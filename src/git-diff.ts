export interface DiffHunk { start: number; end: number; header: string }

/** Line indices into a single-file unified diff, including no-final-newline markers. */
export function diffHunks(diff: string): DiffHunk[] {
  const lines = diff.split("\n"), hunks: DiffHunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(lines[i])) continue;
    if (hunks.length) hunks[hunks.length - 1].end = i;
    hunks.push({ start: i, end: lines.length, header: lines[i] });
  }
  return hunks;
}
export function hunkAtLine(diff: string, line: number): number {
  const hunks = diffHunks(diff);
  if (!hunks.length) return -1;
  let index = 0;
  for (let i = 0; i < hunks.length; i++) if (hunks[i].start <= line) index = i;
  return index;
}
export function singleHunkPatch(diff: string, index: number): string {
  const hunks = diffHunks(diff), hunk = hunks[index];
  if (!hunk) throw new Error("Select a textual diff hunk first");
  const lines = diff.split("\n");
  if (lines.filter(line => line.startsWith("diff --git ")).length !== 1 ||
      lines.slice(0, hunks[0].start).some(line => /^(new file mode|deleted file mode|old mode|new mode|rename |copy |GIT binary patch)/.test(line))) {
    throw new Error("Single-hunk revert supports modified text files only; use Revert File for additions, deletions, or mode changes");
  }
  return [...lines.slice(0, hunks[0].start), ...lines.slice(hunk.start, hunk.end)].join("\n").replace(/\n*$/, "\n");
}
