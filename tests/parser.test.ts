//৪টি test হলো RSS parsing, Atom parsing, HTML rejection এবং অসম্পূর্ণ XML rejection
import test from "node:test";
import assert from "node:assert/strict";
import { parseFeed, FeedParserError } from "../parser";

const rss = `<rss><channel><title>T</title>
  <item><title>One</title><guid>1</guid></item>
  <item><title><![CDATA[Two & more]]></title><guid>2</guid></item>
</channel></rss>`;

test("parses RSS items", () => {
  const feed = parseFeed(rss);

  assert.equal(feed.format, "rss");
  assert.equal(feed.title, "T");
  assert.equal(feed.items.length, 2);
});

test("parses an Atom entry", () => {
  const feed = parseFeed(
    `<feed><title>A</title>
      <entry>
        <title>E</title>
        <link href="http://x"/>
      </entry>
    </feed>`
  );

  assert.equal(feed.format, "atom");
  assert.equal(feed.items.length, 1);
});

test("rejects an HTML page", () => {
  assert.throws(
    () => parseFeed("<html><body>hello</body></html>"),
    (e: unknown) =>
      e instanceof FeedParserError &&
      e.code === "UNSUPPORTED_FORMAT"
  );
});

test("rejects a cut-off feed", () => {
  assert.throws(
    () => parseFeed("<rss><channel><item><title>x"),
    (e: unknown) => e instanceof FeedParserError
  );
});
