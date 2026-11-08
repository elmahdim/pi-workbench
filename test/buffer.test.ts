import { test } from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/buffer.ts";

test("preserves BOM, tabs, mixed newlines, and no final newline", () => {
  const text = "\ufeff\tfirst\r\nsecond\nthird\rfourth";
  const b = new TextBuffer(text);
  assert.equal(b.text, text); assert.equal(b.eol, "\r\n");
  for (let line = 0; line < b.lines.length; line++) {
    for (let col = 0; col <= b.lines[line].length; col++) assert.deepEqual(b.position(b.offset({ line, col })), { line, col });
  }
  b.move(1, 6); b.replace("!"); b.undo(); assert.equal(b.text, text); assert.equal(b.dirty, false);
  b.redo(); assert.equal(b.lines[1], "second!"); assert.equal(b.dirty, true);
});
test("cross-line selection replaces exactly and undo restores selection", () => {
  const b = new TextBuffer("abc\r\ndef"); b.move(0, 1); b.move(1, 2, true);
  assert.equal(b.selection, "bc\r\nde"); b.replace("X"); assert.equal(b.text, "aXf");
  b.undo(); assert.equal(b.selection, "bc\r\nde"); b.redo(); assert.equal(b.text, "aXf");
});
test("deletion respects CRLF and grapheme clusters", () => {
  const b = new TextBuffer("a👨‍👩‍👧‍👦é\r\nx");
  b.move(1, 0); b.delete(-1); assert.equal(b.text, "a👨‍👩‍👧‍👦éx");
  b.delete(-1); assert.equal(b.text, "a👨‍👩‍👧‍👦x");
  b.delete(-1); assert.equal(b.text, "ax"); b.undo(); assert.equal(b.text, "a👨‍👩‍👧‍👦x");
});
test("boundary deletion is a no-op; find wraps and supports replacement", () => {
  const b = new TextBuffer("one two one"); b.delete(-1); assert.equal(b.dirty, false);
  assert.equal(b.find("one"), true); assert.equal(b.selection, "one");
  assert.equal(b.find("one"), true); assert.equal(b.anchor?.col, 8);
  assert.equal(b.find("one"), true); assert.equal(b.anchor?.col, 0);
  b.replace("three"); assert.equal(b.text, "three two one");
  b.move(0, b.text.length); b.delete(1); assert.equal(b.text, "three two one");
});
