// Shapes shared by the parser, the server and the browser front end.
// This file holds types only, so nothing of it ends up in the built JavaScript.

/** rss = RSS 2.0, atom = Atom, rss1 = RDF / RSS 1.0 */
export type FeedFormat = "rss" | "atom" | "rss1";

/** One article after normalize(): the common shape every feed format maps to. */
export interface Article {
  guid: string;
  title: string;
  link: string;
  image: string;
  summary: string;
  body: string;
  date: string;
  ts: number;
  author: string;
}

/** An article as the API returns it (guid and ts stay in SQLite). */
export type ArticleRow = Omit<Article, "guid" | "ts">;

/** A feed in the sidebar, as returned by GET /api/feeds. */
export interface Feed {
  id: string;
  name: string;
  format: string | null;
  updated_at: string | null;
  source: "default" | "user";
  count: number;
}

/** Response of GET /api/feeds/:id/articles */
export interface ArticlesResponse {
  format: string | null;
  updated_at: string | null;
  articles: ArticleRow[];
}

/** Every route answers with this on failure. */
export interface ApiError {
  error: string;
}
