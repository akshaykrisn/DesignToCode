# Skills Onboard — VS Code Extension

A beautiful, guided onboarding experience that extracts bundled AI agent skill files and agent definitions into any repository.

## How it works

1. **Introduction** — Explains what the extension does on first launch
2. **Analysis** — Triggers a background GitHub Copilot LM request to scan your repo and recommend the best placement strategy (falls back to heuristics if Copilot is unavailable)
3. **Extraction** — Copies bundled `.github/` configuration (skills, agents, instructions) from the extension package into the chosen workspace directory
4. **Feedback Loop (Optional)** — Link a Confluence Personal Access Token (PAT) to enable one-click syncing of your local skill modifications back to the team's wiki
5. **Verification** — Confirms all files are present and correctly placed

## Bundled skills

Add your own payload folders under `.github/` in this repository:

```
skills/
  my-skill/
    SKILL.md          ← required, follows Agent Skills spec
    supporting.md     ← optional supporting resources
    script.sh         ← optional scripts
```

## Compatibility

Extracted skills work with:
- **GitHub Copilot** (via `.github/skills/`)
- **Claude Code** (via `.claude/skills/`)
- **Cursor, Windsurf, Codex CLI** (via `.agents/skills/`)

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to open Extension Development Host
```

## Triggering onboarding manually

Open the Command Palette (`Ctrl+Shift+P`) and run:
```
Skills Onboard: Start Onboarding
```

To sync local modifications back to Confluence, run:
```
Skills Onboard: Contribute Skill Updates
```
