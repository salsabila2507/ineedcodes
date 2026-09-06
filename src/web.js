// web.js: web capability layer (master prompt #27). fetch_url retrieves known URLs,
// web_search uses a configurable provider. Web content is untrusted input.
// No search provider configured = honest "unavailable", never a fake search.

const MAX_BYTES = 200_000;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { output: 'Error: not a valid URL.' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { output: 'Error: only http and https URLs are supported.' };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'ineed/1.4 (+https://ineed.codes)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1' },
      redirect: 'follow'
    });
    clearTimeout(timer);
    const type = res.headers.get('content-type') ?? '';
    let body = await res.text();
    if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES) + '\n[truncated]';
    if (type.includes('html')) {
      const text = stripHtml(body);
      return { output: `HTTP ${res.status} ${url}\n${text.slice(0, 15_000)}` };
    }
    return { output: `HTTP ${res.status} ${url}\n${body.slice(0, 15_000)}` };
  } catch (err) {
    return { output: `Error: fetch failed: ${err.message}` };
  }
}

export function searchConfigured(cfg) {
  return Boolean(cfg?.searchUrl);
}

// Uses any search engine that accepts {query} in a URL template and returns HTML/JSON,
// e.g. a self-hosted SearXNG: http://localhost:8888/search?q={query}&format=json
export async function webSearch(cfg, query) {
  if (!searchConfigured(cfg)) {
    return { output: 'Search unavailable: no search provider configured. Set "searchUrl" in ~/.ineedcodes/config.json (a URL template containing {query}). Web page reading via fetch_url still works.' };
  }
  const url = String(cfg.searchUrl).replace('{query}', encodeURIComponent(String(query).slice(0, 300)));
  const r = await fetchUrl(url);
  if (r.output.startsWith('Error:')) return { output: `Error: web_search: ${r.output}` };
  return { output: `web search for "${query}":\n${r.output.slice(0, 8_000)}` };
}
