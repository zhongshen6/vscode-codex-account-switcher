"use strict";

const fsNative = require("fs");
const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");
const codexPatch = require("./codexPatch");

function getConfig() {
  return vscode.workspace.getConfiguration("codexAccountSwitcher");
}

function getConfiguredPath(key) {
  const value = getConfig().get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getAccountsDir() {
  const configured = getConfiguredPath("accountsDir");
  if (configured) {
    return configured;
  }

  return path.join(path.dirname(getCodexDir()), ".codex-accounts");
}

function getCodexDir() {
  const configured = getConfiguredPath("codexDir");
  if (configured) {
    return configured;
  }

  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  return path.join(homeDir, ".codex");
}

function getCurrentAuthPath() {
  return path.join(getCodexDir(), "auth.json");
}

function formatDate(isoString) {
  if (!isoString) {
    return "到期时间未知";
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "到期时间未知";
  }

  return date.toLocaleString("zh-CN", { hour12: false });
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    const jsonText = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function readAccountMetadata(authPath) {
  const authText = await fs.readFile(authPath, "utf8");
  const auth = JSON.parse(authText);
  const idPayload = decodeJwtPayload(auth?.tokens?.id_token) || {};
  const accessPayload = decodeJwtPayload(auth?.tokens?.access_token) || {};
  const authPayload = idPayload["https://api.openai.com/auth"] || accessPayload["https://api.openai.com/auth"] || {};
  const profilePayload = accessPayload["https://api.openai.com/profile"] || {};
  const planType = authPayload.chatgpt_plan_type || "未知";
  const email = idPayload.email || profilePayload.email || "未知邮箱";
  const userName = idPayload.name || "未知用户";
  const expiresAt = idPayload.exp ? new Date(idPayload.exp * 1000).toISOString() : null;
  const displayName = userName !== "未知用户"
    ? userName
    : email !== "未知邮箱"
      ? email
      : auth?.tokens?.account_id || authPayload.chatgpt_account_id || path.basename(authPath, ".json");

  return {
    auth,
    authPath,
    accountDir: path.dirname(authPath),
    storageName: path.basename(authPath),
    userName,
    email,
    displayName,
    planType,
    expiresAt,
    accountId: auth?.tokens?.account_id || authPayload.chatgpt_account_id || "未知"
  };
}

async function listAccounts() {
  const accountsDir = getAccountsDir();
  let entries = [];
  try {
    entries = await fs.readdir(accountsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const accounts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }

    const authPath = path.join(accountsDir, entry.name);
    try {
      accounts.push(await readAccountMetadata(authPath));
    } catch {
      continue;
    }
  }

  accounts.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  return accounts;
}

async function readCurrentAccountMetadata() {
  try {
    return await readAccountMetadata(getCurrentAuthPath());
  } catch {
    return null;
  }
}

async function hasCurrentAuthFile() {
  try {
    await fs.access(getCurrentAuthPath());
    return true;
  } catch {
    return false;
  }
}

function sanitizeFilePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
}

function buildAccountFileName(account) {
  const displayPart = sanitizeFilePart(account.displayName) || "account";
  const idPart = sanitizeFilePart(account.accountId) || "unknown";
  return `${displayPart}__${idPart}.json`;
}

async function ensureCurrentAccountSaved() {
  const currentAccount = await readCurrentAccountMetadata();
  if (!currentAccount) {
    return null;
  }

  await fs.mkdir(getAccountsDir(), { recursive: true });
  const targetPath = path.join(getAccountsDir(), buildAccountFileName(currentAccount));

  await fs.copyFile(getCurrentAuthPath(), targetPath);
  return currentAccount;
}

async function warmAccountCache(statusBarItem) {
  try {
    await ensureCurrentAccountSaved();
    await listAccounts();
    if (statusBarItem) {
      await updateStatusBar(statusBarItem);
    }
  } catch {
    // Ignore warm-up failures and let the interactive path handle them later.
  }
}

async function promptReloadWindow(message) {
  const choice = await vscode.window.showInformationMessage(message, "立即重载", "稍后");
  if (choice === "立即重载") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}
async function applyCodexPatchCommand() {
  const result = await codexPatch.applyPatch();
  const message = result.changed
    ? "Codex 补丁已应用。"
    : "Codex 补丁已存在于磁盘中。";
  await promptReloadWindow(`${message} 请重载一次窗口使其生效。`);
}

async function restoreCodexPatchCommand() {
  await codexPatch.restorePatch();
  await promptReloadWindow("Codex 补丁已恢复为原始文件。请重载一次窗口使其生效。");
}

function buildAccountPicks(accounts, currentAccountId) {
  const picks = accounts.map((account) => ({
    label: account.displayName,
    description: account.email,
    detail: `${account.userName} | ${account.planType} | ${formatDate(account.expiresAt)}`,
    account,
    picked: account.accountId === currentAccountId
  }));

  picks.sort((left, right) => {
    const leftCurrent = left.account.accountId === currentAccountId ? 1 : 0;
    const rightCurrent = right.account.accountId === currentAccountId ? 1 : 0;
    return rightCurrent - leftCurrent;
  });

  return picks;
}

async function deleteSavedAccountFile(account, statusBarItem) {
  const confirmed = await vscode.window.showWarningMessage(
    `要删除已保存的账号记录“${account.displayName}”吗？`,
    { modal: true },
    "删除"
  );
  if (confirmed !== "删除") {
    return false;
  }

  await fs.unlink(account.authPath);

  const sidecarTomlPath = account.authPath.replace(/\.json$/i, ".toml");
  try {
    await fs.unlink(sidecarTomlPath);
  } catch {
    // Ignore missing sidecar config files.
  }

  await updateStatusBar(statusBarItem);
  vscode.window.showInformationMessage(`已删除已保存账号：${account.displayName}`);
  return true;
}

async function showAccountQuickPick(statusBarItem, currentAccount, initialDeleteMode = false) {
  let accounts = await listAccounts();
  if (accounts.length === 0) {
    vscode.window.showWarningMessage(`在 ${getAccountsDir()} 中没有找到账号 JSON 文件。`);
    return null;
  }

  const deleteModeButton = {
    iconPath: new vscode.ThemeIcon("trash"),
    tooltip: "开启删除模式"
  };
  const switchModeButton = {
    iconPath: new vscode.ThemeIcon("close"),
    tooltip: "退出删除模式"
  };

  return await new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    let deleteMode = initialDeleteMode;
    let settled = false;
    let busy = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      quickPick.dispose();
      resolve(result);
    };

    const refreshItems = async () => {
      accounts = await listAccounts();
      quickPick.items = buildAccountPicks(accounts, currentAccount?.accountId);
      if (quickPick.items.length === 0) {
        quickPick.hide();
        vscode.window.showInformationMessage("已经没有可用的已保存账号了。");
      }
    };

    const syncMode = () => {
      quickPick.title = deleteMode ? "切换 Codex 账号 [删除模式]" : "切换 Codex 账号";
      quickPick.placeholder = deleteMode
        ? "当前为删除模式。选择一个账号即可删除它的保存记录。"
        : "选择要写入当前 Codex 配置的账号";
      quickPick.buttons = [deleteMode ? switchModeButton : deleteModeButton];
      quickPick.items = buildAccountPicks(accounts, currentAccount?.accountId);
    };

    quickPick.ignoreFocusOut = false;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    syncMode();

    quickPick.onDidTriggerButton(() => {
      deleteMode = !deleteMode;
      syncMode();
    });

    quickPick.onDidHide(() => {
      finish(null);
    });

    quickPick.onDidAccept(async () => {
      if (busy) {
        return;
      }

      const selection = quickPick.selectedItems[0];
      if (!selection) {
        return;
      }

      if (!deleteMode) {
        quickPick.hide();
        finish(selection.account);
        return;
      }

      busy = true;
      quickPick.busy = true;
      quickPick.enabled = false;
      try {
        if (selection.account.accountId === currentAccount?.accountId) {
          return;
        }

        const deleted = await deleteSavedAccountFile(selection.account, statusBarItem);
        if (deleted) {
          currentAccount = await readCurrentAccountMetadata();
          await refreshItems();
          syncMode();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`删除 Codex 账号失败：${message}`);
      } finally {
        busy = false;
        quickPick.busy = false;
        quickPick.enabled = true;
      }
    });

    quickPick.show();
  });
}

async function deleteSavedAccount(statusBarItem) {
  const currentAccount = await readCurrentAccountMetadata();
  const result = await showAccountQuickPick(statusBarItem, currentAccount, true);
  if (!result) {
    return;
  }
}

async function updateStatusBar(statusBarItem) {
  try {
    const current = await readCurrentAccountMetadata();

    if (current) {
      statusBarItem.text = `$(person) Codex: ${current.displayName}`;
      statusBarItem.tooltip = `${current.userName}\n${current.email}\n套餐：${current.planType}`;
    } else {
      statusBarItem.text = "$(person) Codex：未登录";
      statusBarItem.tooltip = "当前没有活动的 Codex 登录。请选择一个账号登录。";
    }
  } catch (error) {
    statusBarItem.text = "$(warning) Codex 账号";
    statusBarItem.tooltip = error instanceof Error ? error.message : "读取账号状态失败";
  }
}

async function switchAccount(statusBarItem) {
  const hadAuthBeforeSwitch = await hasCurrentAuthFile();
  const currentAccount = await ensureCurrentAccountSaved();
  const selection = await showAccountQuickPick(statusBarItem, currentAccount, false);

  if (!selection) {
    return;
  }

  const codexDir = getCodexDir();
  await fs.mkdir(codexDir, { recursive: true });
  await fs.copyFile(selection.authPath, path.join(codexDir, "auth.json"));

  const shouldCopyConfig = getConfig().get("copyConfigToml");
  if (shouldCopyConfig) {
    const sourceConfigPath = selection.authPath.replace(/\.json$/i, ".toml");
    try {
      await fs.access(sourceConfigPath);
      await fs.copyFile(sourceConfigPath, path.join(codexDir, "config.toml"));
    } catch {
      // Ignore missing sidecar config files.
    }
  }

  await updateStatusBar(statusBarItem);

  const message = `已切换到账号：${selection.displayName}`;
  const shouldReload = getConfig().get("reloadAfterSwitch");
  if (shouldReload) {
    if (!hadAuthBeforeSwitch) {
      vscode.window.setStatusBarMessage(`${message}，正在重启扩展宿主...`, 3000);
      await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
      return;
    }

    try {
      vscode.window.setStatusBarMessage(`${message}，正在重载 Codex...`, 3000);
      await vscode.commands.executeCommand(codexPatch.PATCH_COMMAND_ID);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const action = await vscode.window.showWarningMessage(
        `账号已经切换，但无法快速重载 Codex：${detail}`,
        "应用补丁",
        "重载窗口",
        "确定"
      );
      if (action === "应用补丁") {
        await applyCodexPatchCommand();
      } else if (action === "重载窗口") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  } else {
    vscode.window.showInformationMessage(message);
  }
}

function createAuthWatcher(statusBarItem) {
  let watcher = null;
  let debounceTimer = null;

  const refresh = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void updateStatusBar(statusBarItem);
    }, 150);
  };

  const restart = () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }

    const authDir = getCodexDir();
    try {
      watcher = fsNative.watch(authDir, { persistent: false }, (eventType, fileName) => {
        if (fileName && fileName.toLowerCase() !== "auth.json") {
          return;
        }
        if (!fileName && eventType !== "rename" && eventType !== "change") {
          return;
        }
        refresh();
      });
      watcher.on("error", () => {
        refresh();
      });
    } catch {
      watcher = null;
    }
  };

  restart();

  return new vscode.Disposable(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  });
}

function activate(context) {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusBarItem.command = "codexAccountSwitcher.switchAccount";
  statusBarItem.text = "$(person) Codex 账号";
  statusBarItem.tooltip = "正在加载 Codex 账号切换器";
  statusBarItem.show();

  const switchDisposable = vscode.commands.registerCommand("codexAccountSwitcher.switchAccount", async () => {
    try {
      await switchAccount(statusBarItem);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Codex 账号切换失败：${message}`);
    }
  });

  const refreshDisposable = vscode.commands.registerCommand("codexAccountSwitcher.refreshAccounts", async () => {
    await updateStatusBar(statusBarItem);
    vscode.window.showInformationMessage("Codex 账号状态已刷新。");
  });

  const deleteAccountDisposable = vscode.commands.registerCommand("codexAccountSwitcher.deleteAccount", async () => {
    try {
      await deleteSavedAccount(statusBarItem);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`删除 Codex 账号失败：${message}`);
    }
  });

  const applyPatchDisposable = vscode.commands.registerCommand("codexAccountSwitcher.applyCodexPatch", async () => {
    await applyCodexPatchCommand();
  });

  const restorePatchDisposable = vscode.commands.registerCommand("codexAccountSwitcher.restoreCodexPatch", async () => {
    await restoreCodexPatchCommand();
  });

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexAccountSwitcher")) {
      void updateStatusBar(statusBarItem);
    }
  });

  const focusDisposable = vscode.window.onDidChangeWindowState((windowState) => {
    if (windowState.focused) {
      void updateStatusBar(statusBarItem);
    }
  });

  const authWatcherDisposable = createAuthWatcher(statusBarItem);

  context.subscriptions.push(
    statusBarItem,
    switchDisposable,
    refreshDisposable,
    deleteAccountDisposable,
    applyPatchDisposable,
    restorePatchDisposable,
    configDisposable,
    focusDisposable,
    authWatcherDisposable
  );
  vscode.window.setStatusBarMessage("Codex 账号切换器已加载", 4000);
  void updateStatusBar(statusBarItem);
  void warmAccountCache(statusBarItem);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
