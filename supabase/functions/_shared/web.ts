// `fetch_url` tool implementation for the research agent.
// Port of OMA/Agents/shared/tools.py — fetches a URL, strips scripts/styles/nav,
// returns clean text. Tool schema matches the Anthropic tools API.

const MAX_PAGE_TEXT = 50_000;
// Tightened to 15 s so a slow or hung external page can't eat most of the
// 150 s Supabase edge-function wall budget on a single fetch_url call.
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export const FETCH_URL_TOOL_SCHEMA = {
  name: "fetch_url",
  description:
    "Fetch and read the full text content of a web page. Use this to read URLs provided in the project data and to deep-read pages found via web search. Returns the page text with scripts, navigation, and styling removed.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch and read",
      },
    },
    required: ["url"],
  },
};

export async function fetchUrl(url: string): Promise<string> {
  if (!url || typeof url !== "string") return "[خطأ: لم يتم تحديد رابط صحيح]";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      return `[خطأ HTTP ${response.status}: ${url}]`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return `[محتوى غير HTML: ${contentType}. URL: ${url}]`;
    }

    const html = await response.text();
    const text = stripHtml(html);

    if (text.length > MAX_PAGE_TEXT) {
      return text.slice(0, MAX_PAGE_TEXT) + "\n\n[... محتوى مقطوع — الصفحة طويلة جداً ...]";
    }
    return text;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return `[خطأ: انتهت مهلة الاتصال بالصفحة: ${url}]`;
    }
    return `[خطأ غير متوقع: ${(err as Error).message}]`;
  } finally {
    clearTimeout(timer);
  }
}

// Lightweight HTML→text conversion. We intentionally avoid a full DOM parser
// (BeautifulSoup has no direct Deno equivalent) — regex-based stripping is good
// enough for real-estate marketing pages where the signal is long-form Arabic
// prose, not deeply nested markup.
function stripHtml(html: string): string {
  return html
    // Remove whole non-content elements (including their content)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    // Remove all remaining tags (keep inner text)
    .replace(/<[^>]+>/g, "\n")
    // Decode the most common HTML entities
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Collapse whitespace
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
