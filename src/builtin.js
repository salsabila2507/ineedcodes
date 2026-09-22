// builtin.js: the built-in gateway, https://api.ineed.codes (OpenAI-compatible).
// It is offered as the default base URL on first open, and every model it
// exposes shows up dynamically via GET /v1/models - the client never hardcodes
// model ids. The gateway requires a per-user chat-scope API key issued by the
// admin (keyless/anonymous access is not supported), so the key always comes
// from the user's own config or the INEED_API_KEY env var - never from here.

export const BUILTIN = {
  name: 'ineed',
  baseUrl: 'https://api.ineed.codes/v1'
};
