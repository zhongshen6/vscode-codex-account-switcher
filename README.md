# Codex Account Switcher

A VS Code extension that adds a status bar button for switching the active Codex account.

## What it does

- Reads saved account records from a configurable directory
- Shows a Quick Pick window with account metadata
- Copies the selected account auth file into the active Codex profile
- Optionally also copies a same-name `.toml` sidecar file
- Supports deleting saved account records
- Can apply or restore the optional Codex reload patch

## Default paths

- If `codexAccountSwitcher.accountsDir` is empty, the extension uses a sibling folder next to `codexDir`, such as `.codex-accounts`
- If `codexAccountSwitcher.codexDir` is empty, the extension uses `~/.codex`

## Saved account layout

```text
.codex-accounts/
  Account Name__account-id.json
  Account Name__account-id.toml
```

## Settings

- `codexAccountSwitcher.accountsDir`
- `codexAccountSwitcher.codexDir`
- `codexAccountSwitcher.copyConfigToml`
- `codexAccountSwitcher.reloadAfterSwitch`

## Running locally

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window, click the status bar button labeled `Codex`.
