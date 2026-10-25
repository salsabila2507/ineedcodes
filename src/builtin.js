// builtin.js: metadata for the optional built-in gateway, https://api.ineed.codes
// (OpenAI-compatible). This gateway is NOT the default on first open: it requires a
// per-user chat-scope API key issued by the admin (keyless/anonymous access is not
// supported), so beginners bring their own provider instead (see wizard.js).
//
// This module is kept so that users who already have the gateway saved in their
// config, or who paste its base URL by hand, still get the right model namespace.
// Every model it exposes shows up dynamically via GET /v1/models; the client never
// hardcodes model ids, and the key always comes from the user's own config or the
// INEED_API_KEY env var, never from here.

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
