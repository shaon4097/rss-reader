"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
//৪টি test হলো RSS parsing, Atom parsing, HTML rejection এবং অসম্পূর্ণ XML rejection
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const parser_1 = require("../parser");
const rss = `<rss><channel><title>T</title>
  <item><title>One</title><guid>1</guid></item>
  <item><title><![CDATA[Two & more]]></title><guid>2</guid></item>
</channel></rss>`;
(0, node_test_1.default)("parses RSS items", () => {
    const feed = (0, parser_1.parseFeed)(rss);
    strict_1.default.equal(feed.format, "rss");
    strict_1.default.equal(feed.title, "T");
    strict_1.default.equal(feed.items.length, 2);
});
(0, node_test_1.default)("parses an Atom entry", () => {
    const feed = (0, parser_1.parseFeed)(`<feed><title>A</title>
      <entry>
        <title>E</title>
        <link href="http://x"/>
      </entry>
    </feed>`);
    strict_1.default.equal(feed.format, "atom");
    strict_1.default.equal(feed.items.length, 1);
});
(0, node_test_1.default)("rejects an HTML page", () => {
    strict_1.default.throws(() => (0, parser_1.parseFeed)("<html><body>hello</body></html>"), (e) => e instanceof parser_1.FeedParserError &&
        e.code === "UNSUPPORTED_FORMAT");
});
(0, node_test_1.default)("rejects a cut-off feed", () => {
    strict_1.default.throws(() => (0, parser_1.parseFeed)("<rss><channel><item><title>x"), (e) => e instanceof parser_1.FeedParserError);
});
