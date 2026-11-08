export interface Position { line: number; col: number }
interface Snapshot { text: string; cursor: Position; anchor?: Position }
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string) => [...segmenter.segment(text)];

/** File text is never normalized: tabs, BOM, mixed EOLs and final newline survive. */
export class TextBuffer {
  text: string;
  saved: string;
  cursor: Position = { line: 0, col: 0 };
  anchor?: Position;
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  constructor(text: string) { this.text = this.saved = text; }
  get dirty() { return this.text !== this.saved; }
  private indexedText?: string;
  private indexedLines: string[] = [];
  private starts: number[] = [];
  private index() {
    if (this.indexedText === this.text) return;
    this.indexedText = this.text; this.indexedLines = this.text.split(/\r\n|\n|\r/);
    this.starts = [0];
    for (const match of this.text.matchAll(/\r\n|\n|\r/g)) this.starts.push(match.index + match[0].length);
  }
  get lines() { this.index(); return this.indexedLines; }
  get eol() { return this.text.match(/\r\n|\n|\r/)?.[0] ?? "\n"; }
  offset(pos = this.cursor): number {
    this.index();
    return Math.min(this.text.length, (this.starts[pos.line] ?? this.text.length) + pos.col);
  }
  position(offset: number): Position {
    this.index();
    let low = 0, high = this.starts.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.starts[mid] <= offset) low = mid; else high = mid - 1; }
    return { line: low, col: Math.min(this.indexedLines[low].length, offset - this.starts[low]) };
  }
  get range(): [number, number] {
    const a = this.offset(this.anchor ?? this.cursor), b = this.offset();
    return [Math.min(a, b), Math.max(a, b)];
  }
  get selection() { const [a, b] = this.range; return this.text.slice(a, b); }
  private snapshot(): Snapshot { return { text: this.text, cursor: { ...this.cursor }, anchor: this.anchor && { ...this.anchor } }; }
  private restore(s: Snapshot) { this.text = s.text; this.cursor = s.cursor; this.anchor = s.anchor; }
  private checkpoint() {
    this.past.push(this.snapshot());
    // Bound history by both count and approximate UTF-16 storage.
    while (this.past.length > 200 || this.past.reduce((n, s) => n + s.text.length * 2, 0) > 16 * 1024 * 1024) this.past.shift();
    this.future = [];
  }
  replace(value: string) {
    this.checkpoint();
    const [a, b] = this.range;
    this.text = this.text.slice(0, a) + value + this.text.slice(b);
    this.cursor = this.position(a + value.length); this.anchor = undefined;
  }
  applyEdits(edits: { from: number; to: number; text: string }[]) {
    if (!edits.length) return;
    const eol = this.eol, normalized = edits.map(e => ({ ...e, text: e.text.replace(/\r\n|\r|\n/g, eol) }));
    const ordered = [...normalized].sort((a, b) => a.from - b.from);
    for (let i = 0; i < ordered.length; i++) {
      const e = ordered[i], previous = ordered[i - 1];
      if (!Number.isInteger(e.from) || !Number.isInteger(e.to) || e.from < 0 || e.to < e.from || e.to > this.text.length ||
        (previous && (previous.to > e.from || previous.from === e.from))) throw new Error("Invalid or overlapping completion edits");
    }
    this.checkpoint();
    const primary = normalized[0];
    let cursor = primary.from + primary.text.length;
    for (const e of normalized.slice(1)) if (e.to <= primary.from) cursor += e.text.length - (e.to - e.from);
    for (const e of ordered.reverse()) this.text = this.text.slice(0, e.from) + e.text + this.text.slice(e.to);
    this.cursor = this.position(cursor); this.anchor = undefined;
  }
  selectAll() { this.anchor = { line: 0, col: 0 }; this.cursor = this.position(this.text.length); }
  move(line: number, col: number, select = false) {
    if (select) this.anchor ??= { ...this.cursor }; else this.anchor = undefined;
    line = Math.max(0, Math.min(this.lines.length - 1, line));
    const value = this.lines[line];
    col = Math.max(0, Math.min(value.length, col));
    // Never place the cursor inside a grapheme.
    const boundaries = [...graphemes(value).map(g => g.index), value.length];
    this.cursor = { line, col: boundaries.reduce((best, n) => n <= col ? n : best, 0) };
  }
  horizontal(direction: -1 | 1, select = false) {
    const { line, col } = this.cursor;
    const bounds = [...graphemes(this.lines[line]).map(g => g.index), this.lines[line].length];
    if (direction < 0) {
      if (col === 0 && line > 0) this.move(line - 1, this.lines[line - 1].length, select);
      else this.move(line, bounds.filter(n => n < col).at(-1) ?? 0, select);
    } else if (col === this.lines[line].length && line < this.lines.length - 1) this.move(line + 1, 0, select);
    else this.move(line, bounds.find(n => n > col) ?? col, select);
  }
  delete(direction: -1 | 1) {
    if (this.selection) { this.replace(""); return; }
    const original = { ...this.cursor };
    this.horizontal(direction, true);
    if (!this.selection) { this.anchor = undefined; return; }
    // Undo should restore the original caret, not the temporary deletion selection.
    const [a, b] = this.range;
    this.cursor = original; this.anchor = undefined; this.checkpoint();
    this.text = this.text.slice(0, a) + this.text.slice(b);
    this.cursor = this.position(a);
  }
  undo() { const s = this.past.pop(); if (s) { this.future.push(this.snapshot()); this.restore(s); } }
  redo() { const s = this.future.pop(); if (s) { this.past.push(this.snapshot()); this.restore(s); } }
  find(query: string) {
    if (!query) return false;
    const start = this.offset() + (this.selection ? 1 : 0);
    let index = this.text.indexOf(query, start);
    if (index < 0) index = this.text.indexOf(query);
    if (index < 0) return false;
    this.anchor = this.position(index); this.cursor = this.position(index + query.length); return true;
  }
}
