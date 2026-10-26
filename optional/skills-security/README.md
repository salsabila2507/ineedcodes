# Optional security skills pack

This folder holds gated security / pentest skill packs for ineed.

They are **opt-in**. They are:

- **not** part of the npm package (`files` only ships `src`)
- **not** auto-installed when you run `ineed`
- **not** visible to the agent until you deliberately unlock them

## How to install

From a machine that already has ineed:

```bash
ineed skills-sync
```

That clones this repository (shallow) and copies `optional/skills-security/*` into `~/.ineedcodes/skills/`.

## How to unlock

There is no built-in unlock phrase. Set your own:

```bash
ineed unlock
# or: INEED_DEV_KEYWORD=your-secret-phrase ineed "..."
```

Then mention that keyword in a task (or in `/skills`) so the gated skills become visible. Use them only on systems you are authorized to test.

## Adding your own

Drop a `SKILL.md` folder into `~/.ineedcodes/skills/` or `.ineedcodes/skills/` in a project. See the main README for the frontmatter format. Mark sensitive ones with `gated: true` so they stay hidden until your unlock keyword is present.
