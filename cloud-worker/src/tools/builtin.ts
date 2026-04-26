// Anthropic-hosted server-side tools.
//
// Declared as plain object literals so TypeScript infers the discriminated-
// union shape from the `tools` array. (Annotating these as `Tool` is wrong —
// `Tool` is the custom-tool variant only.)
//
// These tools run on Anthropic's infrastructure. The agent emits server-side
// tool-use blocks, Anthropic executes them, and the result lands back in the
// same response. Our client-side code never has to handle them — we just
// declare them and let the API do the work.

/** Anthropic-hosted web search. Newer (`_20260209`) version supports
 *  dynamic filtering — the model writes filter code to narrow results before
 *  they hit the context window.
 *
 *  Both `type` and `name` need to be string-literal-typed for the SDK's
 *  ToolUnion to accept the object — `as const` on the whole literal does
 *  it most cleanly. */
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20260209',
  name: 'web_search',
} as const;

/** Anthropic-hosted URL fetcher. Pairs naturally with `web_search` — search
 *  surfaces URLs, fetch reads them. */
export const WEB_FETCH_TOOL = {
  type: 'web_fetch_20260209',
  name: 'web_fetch',
} as const;

/** Anthropic-hosted Python sandbox. The agent writes code (e.g. python-pptx
 *  to build a deck), runs it, and any files written end up in the per-
 *  session container. We can pull those files back out via the Files API
 *  using the `file_id` that lands in `bash_code_execution_output` blocks
 *  in the response.
 *
 *  Pre-installed Python libs include python-pptx, python-docx, openpyxl,
 *  pandas, matplotlib, pillow — i.e. everything we'd want for deck
 *  generation. The container is sandboxed (no internet), so anything that
 *  needs network access has to come in via web_search/web_fetch first. */
export const CODE_EXECUTION_TOOL = {
  type: 'code_execution_20260120',
  name: 'code_execution',
} as const;
