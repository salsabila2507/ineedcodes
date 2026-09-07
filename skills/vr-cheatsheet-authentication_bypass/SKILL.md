---
name: vr-cheatsheet-authentication_bypass
description: >-
  Vulnerability research reference: authentication_bypass
gated: true
---
# 🔐 Authentication & Identity (JWT, OAuth, SAML) Cheatsheet

---

## 🎟️ 1. JWT (JSON Web Tokens) Attacks

*JWTs are base64-url encoded strings divided into three parts: `Header.Payload.Signature`. Always decode them (e.g., at jwt.io) to inspect the claims.*

### The `alg=none` Bypass

*Many libraries fail to verify the signature if the header explicitly tells them not to.*

1. Decode the Header.
2. Change `"alg": "HS256"` (or RS256) to `"alg": "none"` (also try `"None"`, `"NONE"`).
3. Modify the Payload (e.g., `"role": "admin"`).
4. Remove the signature but **leave the trailing dot**.

* **Payload:** `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1c2VyIjoiaGFja2VyIiwicm9sZSI6ImFkbWluIn0.`

### Key Confusion (Algorithm Swap: RS256 -> HS256)

*If the server expects an RSA public key (RS256) but you force it to use HMAC (HS256), the server might verify the token using its own public key as the HMAC secret.*

1. Obtain the server's public key (often at `/.well-known/jwks.json`).
2. Change the header algorithm to `HS256`.
3. Sign your forged token using the **public key string** as the HMAC secret.

### JWK (JSON Web Key) Injection

*If the token header accepts a `jwk` parameter, you can inject your own public key and sign the token with your matching private key.*

```json
// Malicious Header
{
  "alg": "RS256",
  "jwk": {
    "kty": "RSA",
    "e": "AQAB",
    "n": "vOUR_MALICIOUS_PUBLIC_KEY_MODULUS..."
  }
}

```

### Offline Cracking

*If the JWT uses HS256 (symmetric key), extract it and attempt to crack the secret offline.*

```bash
hashcat -a 0 -m 16500 jwt.txt rockyou.txt

```

---

## 🤝 2. OAuth 2.0 & OpenID Connect (OIDC)

*OAuth is an authorization framework; OIDC adds an identity layer on top. Vulnerabilities usually stem from bad implementation, not the protocol itself.*

### Redirect URI Manipulation (Token Stealing)

*The `redirect_uri` parameter controls where the OAuth provider sends the authorization code or token. If this is not strictly whitelisted, you can steal the token.*

* **Target:** `https://provider.com/auth?client_id=123&redirect_uri=https://attacker.com`
* **Bypasses:**
* `https://client.com.attacker.com` (Subdomain bypass)
* `https://client.com/callback?redirect=https://attacker.com` (Open redirect chaining)
* `https://client.com%2Eattacker.com` (URL encoding)
* `https://client.com@attacker.com` (Credentials syntax)



### CSRF via Missing `state` Parameter

*If the initial authorization request lacks a `state` parameter (or the server doesn't validate it), you can force a victim to log into your account.*

1. Attacker initiates a login with the provider but intercepts the response containing the authorization `code`.
2. Attacker drops the request and sends the callback URL (with the `code`) to the victim.
3. The victim clicks the link, tying their local session to the attacker's third-party account (useful for capturing sensitive info saved to the account).

### Pre-Account Takeover (Implicit Trust)

*If an application allows email/password registration AND OAuth login (e.g., "Log in with Google"), check if it verifies emails.*

1. Attacker registers an account using `victim@company.com` and a password they control.
2. Victim later logs in using "Log in with Google".
3. If the application merges the accounts without verifying the initial email, the attacker still has access via the password.

---

## 🏢 3. SAML (Security Assertion Markup Language)

*SAML uses XML to pass identity assertions between an Identity Provider (IdP) and a Service Provider (SP).*

### XML Signature Wrapping (XSW)

*SAML messages are signed to prevent tampering. XSW involves injecting a fake assertion while keeping the original, validly signed assertion intact to trick the parser.*

1. Intercept the SAML Response (base64 decoded).
2. Clone the `<Assertion>` block.
3. Modify the cloned assertion (e.g., change the `<NameID>` to `admin@corp.com`).
4. Place the cloned assertion in a way that the signature validation logic checks the *original*, but the application logic reads the *fake* one (e.g., moving the original assertion into a wrapper element).

* **Tool:** Use the **SAML Raider** extension in Burp Suite to automate XSW attacks.

### Signature Stripping

*Some poorly configured SPs only validate the signature if it exists.*

1. Intercept the SAML response.
2. Completely delete the `<ds:Signature>` block.
3. Modify the assertion and forward it.

### XML Comment Injection

*Tricking the parser's username extraction logic by breaking the string with XML comments.*

* **Target Account:** `admin@corp.com`
* **Registered Malicious Account:** `admin@corp.com.evil.com`
* If the parser strips comments before checking the database, it evaluates to `admin@corp.com.evil.com`. If it strips comments *after* string evaluation, it might truncate or bypass filters to match `admin@corp.com`.

---

## 🚪 4. General Authentication & MFA Flaws

### MFA Response Manipulation

*Sometimes the server sends the MFA success/fail status to the client to make routing decisions.*

* Intercept the HTTP response from a failed MFA attempt:
```http
HTTP/1.1 401 Unauthorized
{"success": false, "message": "Invalid Code"}

```


* Modify it to simulate success before it hits the browser:
```http
HTTP/1.1 200 OK
{"success": true, "message": "Authenticated"}

```



### Password Reset Host Header Poisoning

*If the server uses the HTTP `Host` header to generate the password reset link, you can steal the token.*

```http
POST /api/reset-password HTTP/1.1
Host: evil-server.com
Content-Type: application/json

{"email": "admin@target.com"}

```

*If vulnerable, the server emails the victim a link like: `https://evil-server.com/reset?token=123xyz`. When the victim clicks, the attacker captures the token.*

---

## Takeaways

### Offensive Perspective

* **The "Trust but Don't Verify" Paradigm:** Applications often assume that because a token *looks* like it came from a trusted provider (Google, Okta, Auth0), it is safe. Always test what happens when you strip the signature (`alg=none`) or alter the cryptographic algorithm (e.g., swapping RS256 for HS256). If the backend dynamically trusts the `alg` header without enforcing a strict whitelist, the door is wide open.
* **Exploit the Translation Gap (SAML/OAuth):** In enterprise SSO, vulnerabilities almost always live in the parsing differences between the Identity Provider (IdP) and the Service Provider (SP). For example, in SAML XML Signature Wrapping (XSW), the goal is to find out if the SP's signature validator looks at one part of the document while the actual application logic reads another. Find the desync, find the bug.
* **State and Context Loss:** Look for missing `state` or `nonce` parameters in OAuth flows. Developers frequently implement the "happy path" for user login but completely forget to protect against an attacker forcing a victim into a specific session (Login CSRF) or intercepting the authorization code via open redirects.

### Defensive Perspective

* **Never Roll Your Own Crypto or Parsers:** Whether it's JWT validation or parsing SAML XML, strictly use established, heavily audited libraries. The vast majority of identity-related CVEs over the last decade stem from developers trying to manually parse claims or verify signatures using custom string manipulation or regex.
* **Enforce Strict Cryptographic Expectations:** Do not let the client dictate the cryptographic algorithm. If your application expects an RSA-signed token (RS256), configure the backend to explicitly *reject* HS256, `none`, or any other algorithm. Never blindly trust the `alg` header provided by the user's token.
* **Modernize OAuth Implementations:** Always mandate the `state` parameter to tie the authorization request to the user's specific browser session, preventing CSRF. Furthermore, implement PKCE (Proof Key for Code Exchange) by default—even for confidential backend web clients—to comprehensively protect against authorization code interception.
* **Harden XML Parsers (SAML):** Before a SAML signature is even verified, the underlying XML parser must be locked down. Explicitly disable XML External Entities (XXE) and Document Type Definitions (DTDs) to prevent entity expansion attacks. Ensure the parser enforces strict schema validation so cloned or wrapper assertions (XSW) cause the transaction to fail safely.

> Source: skraft9/vulnerability-research. Authorized security work only. Gated skill: needs the developer keyword.
