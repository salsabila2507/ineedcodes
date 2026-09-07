---
name: vr-cheatsheet-reverse_engineering
description: >-
  Vulnerability research reference: reverse_engineering
gated: true
---
# 🔄 Reverse Engineering (Ghidra & GDB) Cheatsheet

---

## 🐞 1. GDB: Dynamic Analysis & Execution Control

*Commands for stepping through execution, setting breakpoints, and controlling the binary flow.*

### Starting & Attaching

*Launch binaries or hook into running processes.*

```bash
gdb ./binary          # Start GDB with the target binary
gdb -p <PID>          # Attach to a running process
gdb -c core ./binary  # Load a core dump for post-crash analysis

```

### Execution & Breakpoints

*Control how the program runs and where it stops.*

| Command | Shortcut | Description |
| --- | --- | --- |
| `run [args]` | `r` | Start execution (optionally pass CLI arguments). |
| `break *0xADDR` | `b` | Set a breakpoint at a specific memory address. |
| `break main` | `b` | Set a breakpoint at a function name. |
| `continue` | `c` | Resume execution until the next breakpoint or crash. |
| `stepi` | `si` | Execute exactly one machine instruction (steps *into* calls). |
| `nexti` | `ni` | Execute one machine instruction (steps *over* calls). |
| `finish` |  | Run until the current function returns. |

---

## 🧠 2. GDB: Memory & Register Inspection

*Commands for dumping memory contents and analyzing the CPU state.*

### Examining Registers

*View the current state of CPU registers.*

```gdb
info registers        # Show all standard integer registers
info registers eflags # Show status flags (Zero flag, Carry flag, etc.)
print $rax            # Print the value of a specific register

```

### Examining Memory (`x` command)

*Format: `x/[Count][Format][Size] Address*`

```gdb
# Formats: x (hex), d (decimal), s (string), i (instruction)
# Sizes: b (byte), h (halfword/2-bytes), w (word/4-bytes), g (giant/8-bytes)

x/10i $pc             # Disassemble the next 10 instructions at the Program Counter
x/4xg $rsp            # View the top 4 QWORDs (8-bytes) on the stack
x/s 0x4005d0          # Read a null-terminated string at the specified address
x/32wx $rbp-0x20      # Dump 32 DWORDs (4-bytes) in hex starting from a local variable

```

---

## 🐉 3. Ghidra: Static Analysis & Navigation

*Shortcuts and workflows for mapping out the binary without executing it.*

### Core Navigation Shortcuts

*Move around the disassembly and decompiled views quickly.*

| Action | Shortcut | Description |
| --- | --- | --- |
| **Go To Address** | `G` | Jump to a specific hex address or symbol name. |
| **Find References** | `Ctrl + Shift + F` | Find cross-references (XREFs) to a function or string. |
| **Search Strings** | `Search -> For Strings` | Extract all hardcoded strings (useful for finding error messages). |
| **Search Memory** | `Search -> Memory` | Scan for specific hex byte sequences or patterns. |
| **Rename Symbol** | `L` | Rename a function, variable, or label (updates globally). |

### Decompiler Manipulation

*Clean up Ghidra's C-pseudocode output to make it readable.*

```text
- Retype Variable (Ctrl + L): Change an 'int' to a 'char*' or custom struct pointer.
- Edit Function Signature: Right-click the function name to fix incorrect arguments/returns.
- Auto-Create Struct: Right-click a pointer variable -> "Auto Create Structure" to map offsets.

```

---

## 🌉 4. Bridging Ghidra and GDB (Dealing with ASLR/PIE)

*When a binary is compiled with PIE (Position Independent Executable), Ghidra's static addresses won't match GDB's dynamic addresses.*

### Step 1: Find Ghidra's Image Base

1. Open the **Memory Map** in Ghidra (`Window -> Memory Map`).
2. Look at the `Start` address of the executable segment (usually `0x00100000` or `0x00400000`).

### Step 2: Find GDB's Process Base

1. Start the program in GDB and hit a breakpoint.
2. Run `info proc mappings` or `vmmap` (if using GEF/Pwndbg).
3. Look for the lowest start address associated with your binary's path.

### Step 3: Calculate the Target Address

*To set a breakpoint in GDB at a function you found in Ghidra:*

```text
Target GDB Address = (Ghidra Function Address - Ghidra Image Base) + GDB Process Base

```

---

## 🩹 5. Binary Patching (Ghidra)

*Modifying the binary to bypass checks or alter behavior.*

### Modifying Instructions

1. Go to the Listing View (Disassembly).
2. Right-click the instruction -> **Patch Instruction** (`Ctrl + Shift + G`).
3. Type the new assembly (e.g., change `je` to `jmp`, or write `nop`).

### Exporting the Patched Binary

1. File -> **Export Program** (`O`).
2. Set Format to **Binary** or **Original File**.
3. *Note: Original File export might require external scripts (like `SavePatch.py`) to properly rebuild ELF/PE headers depending on the Ghidra version.*

> Source: skraft9/vulnerability-research. Authorized security work only. Gated skill: needs the developer keyword.
