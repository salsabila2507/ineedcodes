---
name: vr-methodology-mindset_and_tips
description: >-
  Vulnerability research reference: mindset_and_tips
gated: true
---
# The Attacker Mindset

Remember, you're actively searching for things that *aren't* supposed to be there. 

Because of this, you can sink hours, days, or even weeks into a target and walk away with nothing. Early on, this will feel like failure. 

It is critical to understand that **failing repeatedly is an inherent part of the process.** 

Taking a few hits and running into dead ends before finding a breakthrough is standard; it takes relentless reps & a little bit of luck.

---

## Duplicates

Duplicates always sting. But they are signals of a valid finding. Try to sweep for related siblings and apply the knowledge to future hunts. Try to hunt where others aren't. Be creative.

---

## Tips for Success

If an application responds to an input in an unexpected way (slight delay in response, strange error codes, etc.), keep pulling on that thread. 

Show up every week. Keep putting in the work. It takes hundreds, if not thousands, of hours of dedicated focus to find a vulnerability.

When selecting targets, focus on software architectures and environments you are already deeply familiar with.

Study the developer documentation, API specifications, and administrative guides.

Time spent understanding the code and application flow is never wasted. Look for hidden endpoints, legacy API paths, and complex logic chains.

Reading existing vulnerability advisories is one of the fastest ways to level up. Analyze past reports to understand the attacker's methodology. 

Reviewing patches that resolve vulnerabilities will help you identify what a vulnerable code path looks like versus a secure one. Studying past exploits drives inspiration for future hunts.

Practice against intentionally vulnerable applications. 

The [PortSwigger Web Security Academy Labs](https://portswigger.net/web-security/all-labs) offer a black-box environment to test a variety of vulnerability types safely.

## Resources

* [GitHub Advisory Database](https://github.com/advisories)
* [Talos Vulnerability Reports](https://talosintelligence.com/vulnerability_reports)
* [Tenable Research Advisories](https://www.tenable.com/security/research)
* [Zero Day Initiative Blog](https://www.zerodayinitiative.com/blog)

> Source: skraft9/vulnerability-research. Authorized security work only. Gated skill: needs the developer keyword.
