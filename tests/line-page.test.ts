import { test } from "node:test";
import assert from "node:assert/strict";
import { linePage, MAX_RETRIEVE_CHARS } from "../src/mcp/line-page";

test("long single lines can be reconstructed without duplicate or missing characters", () => {
  const raw = "a".repeat(11999) + "😀" + "b".repeat(13000) + "最后";
  let offset = 0;
  let restored = "";
  do {
    const page = linePage(raw, 1, 1, offset)!;
    assert.ok(page.text.length <= MAX_RETRIEVE_CHARS);
    assert.equal(page.text.isWellFormed(), true);
    restored += page.text;
    if (page.nextOffsetChars == null) break;
    assert.ok(page.nextOffsetChars > offset);
    offset = page.nextOffsetChars;
  } while (true);
  assert.equal(restored, raw);
});

test("line ranges preserve CRLF and expose real bounds and remaining lines", () => {
  const raw = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\r\n");
  const page = linePage(raw, 2, 180)!;
  assert.equal(page.text, raw.split("\n").slice(1, 161).join("\n"));
  assert.equal(page.endLine, 161);
  assert.equal(page.nextStartLine, 162);
  assert.equal(linePage(raw, 199, 10)!.endLine, 200);
  assert.equal(linePage(raw, 201, 10), null);
  assert.equal(linePage(raw, 1, 1, 100), null);
});

test("invalid cursors fail instead of silently fetching other content", () => {
  for (const invalid of [0, -1, 1.2, NaN, Infinity]) {
    assert.throws(() => linePage("abc", invalid, 1));
    assert.throws(() => linePage("abc", 1, invalid));
  }
  assert.throws(() => linePage("abc", 1, 1, -1));
  assert.throws(() => linePage("😀abc", 1, 1, 1), /Unicode/);
});
