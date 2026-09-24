// builtin.js: the built-in gateway, https://api.ineed.codes (OpenAI-compatible).
// It is offered as the default base URL on first open, and every model it
// exposes shows up dynamically via GET /v1/models - the client never hardcodes
// model ids. The gateway requires a per-user chat-scope API key issued by the
// admin (keyless/anonymous access is not supported), so the key always comes
// from the user's own config or the INEED_API_KEY env var - never from here.

// modelAlias is the one name this gateway's models are shown under. It fronts
// several upstream providers, so without it the list arrives as "upstream/model"
// and the user sees who is behind each model. Anyone who brings their own base
// URL gets exactly what that provider sends, with nothing to switch on.
export const BUILTIN = {
  name: 'ineed',
  baseUrl: 'https://api.ineed.codes/v1',
  modelAlias: 'ineed'
};

// the display namespace for a base URL: only the built-in gateway carries one
export const aliasFor = baseUrl => (String(baseUrl) === BUILTIN.baseUrl ? BUILTIN.modelAlias : '');
