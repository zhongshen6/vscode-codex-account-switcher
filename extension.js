"use strict";

const fsNative = require("fs");
const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");
const codexPatch = require("./codexPatch");

const QUOTA_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_REFRESH_SKEW_SECONDS = 60;
const QUOTA_REQUEST_TIMEOUT_MS = 15000;
const QUOTA_SCHEDULER_POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_QUOTA_REFRESH_INTERVAL_MINUTES = 60;
const DEFAULT_QUOTA_MIN_INTERVAL_MS = 1500;
const QUOTA_FAILURE_MARK_THRESHOLD = 3;
const EXTENSION_META_KEY = "codexAccountSwitcher";
const CONFIG_SECTION = "codexAccountSwitcher";

const quotaCache = new Map();
const quotaInflightRequests = new Map();
let lastQuotaRequestStartedAt = 0;

function getExtensionConfig() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function getBooleanConfig(key, defaultValue) {
  const value = getExtensionConfig().get(key);
  return typeof value === "boolean" ? value : defaultValue;
}

function getNumberConfig(key, defaultValue, minimum = 0) {
  const value = Number(getExtensionConfig().get(key));
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(minimum, value);
}

function shouldAutoReloadCodexAfterSwitch() {
  return getBooleanConfig("autoReloadCodexAfterSwitch", true);
}

function shouldAutoRefreshTokensForInactiveAccounts() {
  return getBooleanConfig("autoRefreshTokensForInactiveAccounts", true);
}

function shouldAutoRefreshQuota() {
  return getBooleanConfig("autoRefreshQuota", true);
}

function getQuotaRefreshIntervalMs() {
  return getNumberConfig("quotaRefreshIntervalMinutes", DEFAULT_QUOTA_REFRESH_INTERVAL_MINUTES, 1) * 60 * 1000;
}

function getQuotaRequestMinIntervalMs() {
  return getNumberConfig("quotaRequestMinIntervalMs", DEFAULT_QUOTA_MIN_INTERVAL_MS, 0);
}

function getSortBy() {
  const value = getExtensionConfig().get("sortBy");
  return value === "displayName" || value === "email" ? value : "quota";
}

function isSortDescending() {
  return getBooleanConfig("sortDescending", false);
}

function getAccountsDir() {
  return path.join(path.dirname(getCodexDir()), ".codex-accounts");
}

function getCodexDir() {
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

function getAccountCacheKey(account) {
  if (account?.accountId && account.accountId !== "未知") {
    return `account:${account.accountId}`;
  }
  return `file:${account?.authPath || ""}`;
}

function isTokenExpired(token, skewSeconds = TOKEN_REFRESH_SKEW_SECONDS) {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number") {
    return false;
  }
  return exp <= Math.floor(Date.now() / 1000) + skewSeconds;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshTokens(refreshToken) {
  const response = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID
      }).toString()
    },
    QUOTA_REQUEST_TIMEOUT_MS
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${raw.slice(0, 200)}`);
  }

  const payload = JSON.parse(raw);
  return {
    idToken: payload.id_token,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken
  };
}

async function writeAccountAuth(authPath, auth) {
  await fs.writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

async function readAuthFromDisk(authPath, fallbackAuth) {
  try {
    const authText = await fs.readFile(authPath, "utf8");
    return JSON.parse(authText);
  } catch {
    return fallbackAuth;
  }
}

function getExtensionMeta(auth) {
  const meta = auth?.[EXTENSION_META_KEY];
  return meta && typeof meta === "object" ? meta : {};
}

function getPersistedQuotaSummary(auth) {
  const meta = getExtensionMeta(auth);
  return meta?.quotaSummary && typeof meta.quotaSummary === "object" ? meta.quotaSummary : null;
}

function getPersistedLastCheckedAt(auth) {
  const meta = getExtensionMeta(auth);
  return typeof meta?.lastQuotaCheckedAt === "number" ? meta.lastQuotaCheckedAt : undefined;
}

function getPersistedFailureCount(auth) {
  const meta = getExtensionMeta(auth);
  return typeof meta?.consecutiveQuotaFailures === "number" ? meta.consecutiveQuotaFailures : 0;
}

function getPersistedQuotaQueryFailed(auth) {
  const meta = getExtensionMeta(auth);
  return meta?.quotaQueryFailed === true;
}

function buildPersistedAuth(auth, patch) {
  const meta = getExtensionMeta(auth);
  return {
    ...auth,
    [EXTENSION_META_KEY]: {
      ...meta,
      ...patch
    }
  };
}

function sanitizeAuthForActivation(auth) {
  if (!auth || typeof auth !== "object") {
    return auth;
  }
  const nextAuth = { ...auth };
  delete nextAuth[EXTENSION_META_KEY];
  return nextAuth;
}

async function persistQuotaSummary(account, summary, lastCheckedAt) {
  const latestAuth = await readAuthFromDisk(account.authPath, account.auth);
  const nextAuth = buildPersistedAuth(latestAuth, {
    quotaSummary: summary,
    lastQuotaCheckedAt: lastCheckedAt,
    consecutiveQuotaFailures: 0,
    quotaQueryFailed: false
  });
  await writeAccountAuth(account.authPath, nextAuth);
}

async function persistQuotaFailureState(account, patch) {
  const latestAuth = await readAuthFromDisk(account.authPath, account.auth);
  const nextAuth = buildPersistedAuth(latestAuth, {
    consecutiveQuotaFailures: patch.consecutiveFailures,
    quotaQueryFailed: patch.failed,
    ...(typeof patch.lastCheckedAt === "number" ? { lastQuotaCheckedAt: patch.lastCheckedAt } : {})
  });
  await writeAccountAuth(account.authPath, nextAuth);
}

async function waitForQuotaRateLimit() {
  const minIntervalMs = getQuotaRequestMinIntervalMs();
  if (minIntervalMs <= 0) {
    lastQuotaRequestStartedAt = Date.now();
    return;
  }

  const elapsed = Date.now() - lastQuotaRequestStartedAt;
  if (elapsed < minIntervalMs) {
    await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastQuotaRequestStartedAt = Date.now();
}

function normalizeRemaining(usedPercent) {
  const used = Math.max(0, Math.min(100, Number.isFinite(usedPercent) ? usedPercent : 0));
  return Math.max(0, Math.min(100, 100 - used));
}

function normalizeReset(resetAt, resetAfterSeconds) {
  if (typeof resetAt === "number" && Number.isFinite(resetAt)) {
    return resetAt;
  }
  if (typeof resetAfterSeconds === "number" && Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0) {
    return Math.floor(Date.now() / 1000) + resetAfterSeconds;
  }
  return undefined;
}

function normalizeWindow(limitWindowSeconds) {
  if (typeof limitWindowSeconds !== "number" || !Number.isFinite(limitWindowSeconds) || limitWindowSeconds <= 0) {
    return undefined;
  }
  return limitWindowSeconds;
}

function isWeeklyQuotaWindow(window) {
  const seconds = normalizeWindow(window?.limit_window_seconds);
  return typeof seconds === "number" && seconds >= 24 * 60 * 60;
}

function resolveRateLimitWindows(primary, secondary) {
  const windows = [primary, secondary].filter(Boolean);
  if (windows.length === 0) {
    return {};
  }
  if (windows.length === 1) {
    return isWeeklyQuotaWindow(windows[0])
      ? { weeklyWindow: windows[0] }
      : { hourlyWindow: windows[0] };
  }

  const sorted = [...windows].sort((left, right) => {
    const leftSeconds = normalizeWindow(left?.limit_window_seconds) || Number.MAX_SAFE_INTEGER;
    const rightSeconds = normalizeWindow(right?.limit_window_seconds) || Number.MAX_SAFE_INTEGER;
    return leftSeconds - rightSeconds;
  });

  return {
    hourlyWindow: sorted[0],
    weeklyWindow: sorted[sorted.length - 1]
  };
}

function parseQuotaSummary(usage) {
  const primary = usage?.rate_limit?.primary_window;
  const secondary = usage?.rate_limit?.secondary_window;
  const codeReviewPrimary = usage?.code_review_rate_limit?.primary_window;
  const { hourlyWindow, weeklyWindow } = resolveRateLimitWindows(primary, secondary);

  return {
    hourlyPercentage: hourlyWindow ? normalizeRemaining(hourlyWindow.used_percent) : undefined,
    hourlyResetTime: normalizeReset(hourlyWindow?.reset_at, hourlyWindow?.reset_after_seconds),
    weeklyPercentage: weeklyWindow ? normalizeRemaining(weeklyWindow.used_percent) : undefined,
    weeklyResetTime: normalizeReset(weeklyWindow?.reset_at, weeklyWindow?.reset_after_seconds),
    codeReviewPercentage: codeReviewPrimary ? normalizeRemaining(codeReviewPrimary.used_percent) : undefined,
    codeReviewResetTime: normalizeReset(codeReviewPrimary?.reset_at, codeReviewPrimary?.reset_after_seconds),
    planType: usage?.plan_type || undefined,
    rawData: usage
  };
}

function setQuotaCacheEntry(account, patch) {
  const key = getAccountCacheKey(account);
  const current = quotaCache.get(key) || {};
  quotaCache.set(key, {
    ...current,
    ...patch
  });
}

function getQuotaCacheEntry(account) {
  return quotaCache.get(getAccountCacheKey(account)) || null;
}

function shouldFetchQuotaOnOpen(account) {
  const entry = getQuotaCacheEntry(account);
  if (!entry) {
    return true;
  }
  return !entry.summary && !entry.refreshing;
}

function shouldRefreshQuotaByAge(account, maxAgeMs) {
  const entry = getQuotaCacheEntry(account);
  if (!entry) {
    return true;
  }
  if (entry.refreshing) {
    return false;
  }
  if (!entry.lastCheckedAt || typeof entry.lastCheckedAt !== "number") {
    return true;
  }
  return Date.now() - entry.lastCheckedAt >= maxAgeMs;
}

function formatPercent(value) {
  return typeof value === "number" ? `${Math.round(value)}%` : "--";
}

function isKnownAccountId(accountId) {
  return typeof accountId === "string" && accountId.length > 0 && accountId !== "未知";
}

function formatRelativeTime(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return null;
  }

  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;

  if (elapsedMs < minuteMs) {
    return "刚刚";
  }
  if (elapsedMs < hourMs) {
    return `${Math.floor(elapsedMs / minuteMs)}分钟前`;
  }
  if (elapsedMs < dayMs) {
    return `${Math.floor(elapsedMs / hourMs)}小时前`;
  }
  if (elapsedMs < weekMs) {
    return `${Math.floor(elapsedMs / dayMs)}天前`;
  }
  if (elapsedMs < monthMs) {
    return `${Math.floor(elapsedMs / weekMs)}周前`;
  }
  return "1月前";
}

function formatQuotaSummary(summary) {
  if (!summary) {
    return "配额未知";
  }

  const parts = [];
  if (typeof summary.hourlyPercentage === "number") {
    parts.push(`5h ${formatPercent(summary.hourlyPercentage)}`);
  }
  parts.push(`周 ${formatPercent(summary.weeklyPercentage)}`);
  if (typeof summary.codeReviewPercentage === "number" && Math.round(summary.codeReviewPercentage) !== 100) {
    parts.push(`审查 ${formatPercent(summary.codeReviewPercentage)}`);
  }

  return parts.join(" | ");
}

function formatQuotaStatus(account) {
  const entry = getQuotaCacheEntry(account);
  if (!entry) {
    return "配额待检查";
  }
  if (entry.failed) {
    return "查询失败";
  }
  if (entry.refreshing) {
    return entry.summary ? formatQuotaSummary(entry.summary) : "$(sync~spin) 配额检查中";
  }
  if (entry.error) {
    return entry.summary ? formatQuotaSummary(entry.summary) : "配额检查失败";
  }
  return formatQuotaSummary(entry.summary);
}

function formatLastQuotaRefresh(account) {
  const entry = getQuotaCacheEntry(account);
  if (!entry?.lastCheckedAt || entry.failed) {
    return null;
  }
  return formatRelativeTime(entry.lastCheckedAt);
}

function formatQuotaResetTime(resetTimestampSeconds) {
  if (typeof resetTimestampSeconds !== "number" || !Number.isFinite(resetTimestampSeconds)) {
    return null;
  }

  const resetDate = new Date(resetTimestampSeconds * 1000);
  if (Number.isNaN(resetDate.getTime())) {
    return null;
  }

  const now = new Date();
  const resetDayStart = new Date(resetDate.getFullYear(), resetDate.getMonth(), resetDate.getDate());
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDiff = Math.round((resetDayStart.getTime() - todayStart.getTime()) / (24 * 60 * 60 * 1000));
  const timeText = resetDate.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });

  if (dayDiff === 0) {
    return `今天 ${timeText}`;
  }

  if (dayDiff === 1) {
    return `明天 ${timeText}`;
  }

  const dateText = resetDate.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  }).replace(/\//g, "-");

  return `${dateText} ${timeText}`;
}

function formatQuickPickQuotaDetail(account) {
  const entry = getQuotaCacheEntry(account);
  if (!entry) {
    return `${account.planType} | 配额待检查`;
  }

  if (entry.failed) {
    return `${account.planType} | 查询失败`;
  }

  if (!entry.summary) {
    return `${account.planType} | ${entry.refreshing ? "$(sync~spin) 配额检查中" : "配额检查失败"}`;
  }

  const parts = [account.planType];
  if (typeof entry.summary.hourlyPercentage === "number") {
    parts.push(`5h ${formatPercent(entry.summary.hourlyPercentage)}`);
  }
  parts.push(`周 ${formatPercent(entry.summary.weeklyPercentage)}`);

  const weeklyResetText = formatQuotaResetTime(entry.summary.weeklyResetTime);
  if (weeklyResetText) {
    parts.push(weeklyResetText);
  }

  const lastRefreshText = formatLastQuotaRefresh(account);
  if (lastRefreshText) {
    parts.push(lastRefreshText);
  }

  return parts.join(" | ");
}

function isSameAccount(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.authPath && right.authPath && left.authPath === right.authPath) {
    return true;
  }

  if (isKnownAccountId(left.accountId) && isKnownAccountId(right.accountId)) {
    return left.accountId === right.accountId;
  }

  if (left.email && right.email && left.email !== "未知邮箱" && right.email !== "未知邮箱") {
    return left.email === right.email;
  }

  return false;
}

function upsertAccount(accounts, nextAccount) {
  const index = accounts.findIndex((account) => isSameAccount(account, nextAccount));
  if (index === -1) {
    return [...accounts, nextAccount];
  }

  const nextAccounts = [...accounts];
  nextAccounts[index] = nextAccount;
  return nextAccounts;
}

function getWeeklyQuotaDisplay(account) {
  const entry = getQuotaCacheEntry(account);
  if (!entry) {
    return {
      icon: "person",
      text: "周 --"
    };
  }

  if (entry.failed) {
    return {
      icon: "warning",
      text: "周 ?"
    };
  }

  const summaryText = `周 ${formatPercent(entry.summary?.weeklyPercentage)}`;
  if (entry.refreshing) {
    return {
      icon: "sync~spin",
      text: summaryText
    };
  }

  if (entry.error && !entry.summary) {
    return {
      icon: "warning",
      text: "周 ?"
    };
  }

  return {
    icon: "person",
    text: summaryText
  };
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "zh-CN");
}

function getQuotaSortValue(account) {
  const entry = getQuotaCacheEntry(account);
  if (entry?.failed) {
    return {
      failed: true,
      hourly: 0,
      weekly: 0
    };
  }

  return {
    failed: false,
    hourly: typeof entry?.summary?.hourlyPercentage === "number" ? entry.summary.hourlyPercentage : 0,
    weekly: typeof entry?.summary?.weeklyPercentage === "number" ? entry.summary.weeklyPercentage : 0
  };
}

function compareAccounts(left, right, sortBy, descending) {
  if (sortBy === "quota") {
    const leftQuota = getQuotaSortValue(left);
    const rightQuota = getQuotaSortValue(right);

    if (leftQuota.failed !== rightQuota.failed) {
      return leftQuota.failed ? 1 : -1;
    }

    if (leftQuota.hourly !== rightQuota.hourly) {
      return descending ? rightQuota.hourly - leftQuota.hourly : leftQuota.hourly - rightQuota.hourly;
    }

    if (leftQuota.weekly !== rightQuota.weekly) {
      return descending ? rightQuota.weekly - leftQuota.weekly : leftQuota.weekly - rightQuota.weekly;
    }
  }

  if (sortBy === "displayName") {
    const result = compareText(left.displayName, right.displayName);
    if (result !== 0) {
      return descending ? -result : result;
    }
  }

  if (sortBy === "email") {
    const result = compareText(left.email, right.email);
    if (result !== 0) {
      return descending ? -result : result;
    }
  }

  const fallbackByName = compareText(left.displayName, right.displayName);
  if (fallbackByName !== 0) {
    return fallbackByName;
  }
  return compareText(left.email, right.email);
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
  const persistedQuotaSummary = getPersistedQuotaSummary(auth);
  const persistedLastCheckedAt = getPersistedLastCheckedAt(auth);
  const persistedFailureCount = getPersistedFailureCount(auth);
  const persistedQuotaQueryFailed = getPersistedQuotaQueryFailed(auth);
  const displayName = userName !== "未知用户"
    ? userName
    : email !== "未知邮箱"
      ? email
      : auth?.tokens?.account_id || authPayload.chatgpt_account_id || path.basename(authPath, ".json");

  const metadata = {
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

  if (
    persistedQuotaSummary ||
    typeof persistedLastCheckedAt === "number" ||
    persistedFailureCount > 0 ||
    persistedQuotaQueryFailed
  ) {
    setQuotaCacheEntry(metadata, {
      refreshing: false,
      error: null,
      summary: persistedQuotaSummary || undefined,
      lastCheckedAt: persistedLastCheckedAt,
      consecutiveFailures: persistedFailureCount,
      failed: persistedQuotaQueryFailed
    });
  }

  return metadata;
}

async function refreshAccountTokensIfNeeded(account, currentAccountId) {
  const accessToken = account?.auth?.tokens?.access_token;
  const refreshToken = account?.auth?.tokens?.refresh_token;
  const isCurrentAccount = Boolean(
    currentAccountId &&
    account?.accountId &&
    account.accountId !== "未知" &&
    account.accountId === currentAccountId
  );

  if (!accessToken || isCurrentAccount || !isTokenExpired(accessToken)) {
    return account;
  }

  if (!shouldAutoRefreshTokensForInactiveAccounts()) {
    return account;
  }

  if (!refreshToken) {
    throw new Error("Token 已过期且没有 refresh_token");
  }

  const refreshed = await refreshTokens(refreshToken);
  const nextAuth = {
    ...account.auth,
    tokens: {
      ...account.auth.tokens,
      id_token: refreshed.idToken,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken || refreshToken,
      account_id: account.auth.tokens.account_id || account.accountId
    }
  };

  await writeAccountAuth(account.authPath, nextAuth);
  return await readAccountMetadata(account.authPath);
}

async function requestQuotaUsage(account) {
  const accessToken = account?.auth?.tokens?.access_token;
  if (!accessToken) {
    throw new Error("账号缺少 access_token");
  }

  await waitForQuotaRateLimit();

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json"
  };

  if (account.accountId && account.accountId !== "未知") {
    headers["ChatGPT-Account-Id"] = account.accountId;
  }

  const response = await fetchWithTimeout(
    QUOTA_USAGE_URL,
    {
      method: "GET",
      headers
    },
    QUOTA_REQUEST_TIMEOUT_MS
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${raw.slice(0, 200)}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function refreshQuotaForAccount(account, currentAccountId) {
  const key = getAccountCacheKey(account);
  const inflight = quotaInflightRequests.get(key);
  if (inflight) {
    return inflight;
  }

  const previousEntry = getQuotaCacheEntry(account);

  setQuotaCacheEntry(account, {
    refreshing: true,
    error: null
  });

  const task = (async () => {
    try {
      const effectiveAccount = await refreshAccountTokensIfNeeded(account, currentAccountId);
      const usage = await requestQuotaUsage(effectiveAccount);
      const summary = parseQuotaSummary(usage);
      const lastCheckedAt = Date.now();

      await persistQuotaSummary(effectiveAccount, summary, lastCheckedAt);
      const persistedAccount = await readAccountMetadata(effectiveAccount.authPath);

      setQuotaCacheEntry(persistedAccount, {
        refreshing: false,
        error: null,
        summary,
        lastCheckedAt,
        consecutiveFailures: 0,
        failed: false
      });

      return {
        account: persistedAccount,
        summary
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackSummary = previousEntry?.summary;
      const fallbackLastCheckedAt = previousEntry?.lastCheckedAt;
      const nextConsecutiveFailures = (previousEntry?.consecutiveFailures || 0) + 1;
      const failed = nextConsecutiveFailures > QUOTA_FAILURE_MARK_THRESHOLD;
      const lastCheckedAt = failed || previousEntry?.failed ? Date.now() : fallbackLastCheckedAt;

      await persistQuotaFailureState(account, {
        consecutiveFailures: nextConsecutiveFailures,
        failed,
        lastCheckedAt
      });
      const persistedAccount = await readAccountMetadata(account.authPath);

      setQuotaCacheEntry(account, {
        refreshing: false,
        error: failed || fallbackSummary ? null : message,
        summary: fallbackSummary,
        lastCheckedAt,
        consecutiveFailures: nextConsecutiveFailures,
        failed
      });
      return {
        account: persistedAccount,
        error: failed || fallbackSummary ? null : message
      };
    }
  })();

  quotaInflightRequests.set(key, task);
  try {
    return await task;
  } finally {
    if (quotaInflightRequests.get(key) === task) {
      quotaInflightRequests.delete(key);
    }
  }
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
  let targetAuth = currentAccount.auth;
  try {
    const existingText = await fs.readFile(targetPath, "utf8");
    const existingAuth = JSON.parse(existingText);
    const existingMeta = getExtensionMeta(existingAuth);
    if (Object.keys(existingMeta).length > 0) {
      targetAuth = buildPersistedAuth(currentAccount.auth, existingMeta);
    }
  } catch {
    // Ignore missing or invalid saved account files.
  }

  await writeAccountAuth(targetPath, targetAuth);
  return await readAccountMetadata(targetPath);
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
  vscode.window.setStatusBarMessage(message, 3000);
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}
async function applyCodexPatchCommand() {
  const result = await codexPatch.applyPatch();
  const message = result.changed
    ? "Codex 补丁已应用。"
    : "Codex 补丁已存在于磁盘中。";
  await promptReloadWindow(`${message} 正在重载窗口使其生效。`);
}

async function restoreCodexPatchCommand() {
  await codexPatch.restorePatch();
  await promptReloadWindow("Codex 补丁已恢复为原始文件。正在重载窗口使其生效。");
}

function buildAccountPicks(accounts, currentAccountId) {
  const sortBy = getSortBy();
  const descending = isSortDescending();
  const picks = accounts.map((account) => ({
    label: account.email,
    description: account.userName,
    detail: formatQuickPickQuotaDetail(account),
    account,
    picked: account.accountId === currentAccountId
  }));

  picks.sort((left, right) => {
    const leftCurrent = left.account.accountId === currentAccountId ? 1 : 0;
    const rightCurrent = right.account.accountId === currentAccountId ? 1 : 0;
    if (leftCurrent !== rightCurrent) {
      return rightCurrent - leftCurrent;
    }
    return compareAccounts(left.account, right.account, sortBy, descending);
  });

  return picks;
}

function replaceAccount(accounts, nextAccount) {
  return accounts.map((account) => (account.authPath === nextAccount.authPath ? nextAccount : account));
}

async function resolveSavedCurrentAccount(currentAccount, accounts) {
  let nextAccounts = accounts;
  if (!currentAccount) {
    return {
      currentAccount: null,
      accounts: nextAccounts
    };
  }

  let savedCurrentAccount = nextAccounts.find((account) => isSameAccount(account, currentAccount)) || null;
  if (!savedCurrentAccount) {
    savedCurrentAccount = await ensureCurrentAccountSaved();
    if (savedCurrentAccount) {
      nextAccounts = upsertAccount(nextAccounts, savedCurrentAccount);
    }
  }

  return {
    currentAccount: savedCurrentAccount,
    accounts: nextAccounts
  };
}

async function refreshCurrentAccountQuotaInBackground(statusBarItem, preferredAccount) {
  let currentAccount = preferredAccount || await readCurrentAccountMetadata();
  if (!currentAccount) {
    if (statusBarItem) {
      await updateStatusBar(statusBarItem);
    }
    return null;
  }

  if (currentAccount.authPath === getCurrentAuthPath()) {
    currentAccount = await ensureCurrentAccountSaved();
  }

  if (!currentAccount) {
    if (statusBarItem) {
      await updateStatusBar(statusBarItem);
    }
    return null;
  }

  const result = await refreshQuotaForAccount(currentAccount, currentAccount.accountId);
  if (statusBarItem) {
    await updateStatusBar(statusBarItem);
  }
  return result?.account || currentAccount;
}

async function refreshMissingQuotasInBackground(accounts, currentAccount, onUpdate) {
  let nextAccounts = accounts;
  const currentAccountId = currentAccount?.accountId;
  const targets = accounts.filter((account) => !isSameAccount(account, currentAccount) && shouldFetchQuotaOnOpen(account));

  for (const account of targets) {
    const result = await refreshQuotaForAccount(account, currentAccountId);
    if (result?.account) {
      nextAccounts = replaceAccount(nextAccounts, result.account);
    }
    onUpdate(nextAccounts);
  }

  return nextAccounts;
}

async function refreshAllQuotasInBackground(statusBarItem) {
  if (!shouldAutoRefreshQuota()) {
    return;
  }

  const currentAccount = await readCurrentAccountMetadata();
  let accounts = await listAccounts();
  for (const account of accounts) {
    const result = await refreshQuotaForAccount(account, currentAccount?.accountId);
    if (result?.account) {
      accounts = replaceAccount(accounts, result.account);
    }
  }
  if (statusBarItem) {
    await updateStatusBar(statusBarItem);
  }
}

async function refreshDueQuotasInBackground(statusBarItem) {
  if (!shouldAutoRefreshQuota()) {
    return;
  }

  const maxAgeMs = getQuotaRefreshIntervalMs();
  const currentAccount = await readCurrentAccountMetadata();
  let accounts = await listAccounts();
  const resolvedCurrent = await resolveSavedCurrentAccount(currentAccount, accounts);
  let currentSavedAccount = resolvedCurrent.currentAccount;
  accounts = resolvedCurrent.accounts;

  if (currentSavedAccount) {
    const result = await refreshQuotaForAccount(currentSavedAccount, currentSavedAccount.accountId);
    if (result?.account) {
      currentSavedAccount = result.account;
      accounts = upsertAccount(accounts, result.account);
    }
  }

  const targets = accounts.filter((account) => !isSameAccount(account, currentSavedAccount) && shouldRefreshQuotaByAge(account, maxAgeMs));

  for (const account of targets) {
    const result = await refreshQuotaForAccount(account, currentSavedAccount?.accountId || currentAccount?.accountId);
    if (result?.account) {
      accounts = upsertAccount(accounts, result.account);
    }
  }

  if (statusBarItem) {
    await updateStatusBar(statusBarItem);
  }
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
  const settingsButton = {
    iconPath: new vscode.ThemeIcon("gear"),
    tooltip: "打开扩展设置"
  };
  const restartExtensionHostButton = {
    iconPath: new vscode.ThemeIcon("debug-restart"),
    tooltip: "重启整个扩展宿主"
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
      quickPick.title = deleteMode
        ? `切换 Codex 账号 [删除模式]（共 ${accounts.length} 个）`
        : `切换 Codex 账号（共 ${accounts.length} 个）`;
      quickPick.placeholder = deleteMode
        ? "当前为删除模式。选择一个账号即可删除它的保存记录。"
        : "选择要写入当前 Codex 配置的账号";
      quickPick.buttons = [settingsButton, restartExtensionHostButton, deleteMode ? switchModeButton : deleteModeButton];
      quickPick.items = buildAccountPicks(accounts, currentAccount?.accountId);
    };

    quickPick.ignoreFocusOut = false;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    syncMode();

    void refreshMissingQuotasInBackground(accounts, currentAccount, (nextAccounts) => {
      if (settled) {
        return;
      }
      accounts = nextAccounts;
      quickPick.items = buildAccountPicks(accounts, currentAccount?.accountId);
    });

    quickPick.onDidTriggerButton(async (button) => {
      if (button === settingsButton) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local.codex-account-switcher");
        return;
      }

      if (button === restartExtensionHostButton) {
        quickPick.hide();
        finish(null);
        await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
        return;
      }

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
          void refreshMissingQuotasInBackground(accounts, currentAccount, (nextAccounts) => {
            if (settled) {
              return;
            }
            accounts = nextAccounts;
            quickPick.items = buildAccountPicks(accounts, currentAccount?.accountId);
          });
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
      const weeklyQuotaDisplay = getWeeklyQuotaDisplay(current);
      statusBarItem.text = `$(${weeklyQuotaDisplay.icon}) Codex: ${current.displayName} | ${weeklyQuotaDisplay.text}`;
      statusBarItem.tooltip = [
        current.userName,
        current.email,
        `套餐：${current.planType}`,
        `配额：${formatQuotaStatus(current)}`,
        formatLastQuotaRefresh(current) ? `最近刷新：${formatLastQuotaRefresh(current)}` : null
      ].filter(Boolean).join("\n");
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
  let selection = await showAccountQuickPick(statusBarItem, currentAccount, false);

  if (!selection) {
    return;
  }

  selection = await refreshAccountTokensIfNeeded(selection, currentAccount?.accountId);

  const codexDir = getCodexDir();
  await fs.mkdir(codexDir, { recursive: true });
  await writeAccountAuth(path.join(codexDir, "auth.json"), sanitizeAuthForActivation(selection.auth));

  void refreshCurrentAccountQuotaInBackground(statusBarItem, selection).catch(() => {
    // Ignore immediate quota refresh failures and let the scheduler retry.
  });
  await updateStatusBar(statusBarItem);

  const message = `已切换到账号：${selection.displayName}`;
  const shouldReload = shouldAutoReloadCodexAfterSwitch();
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
        "确定"
      );
      if (action === "应用补丁") {
        await applyCodexPatchCommand();
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

function createQuotaRefreshScheduler(statusBarItem) {
  let quotaRefreshTimer = null;

  const schedule = () => {
    if (quotaRefreshTimer) {
      clearInterval(quotaRefreshTimer);
      quotaRefreshTimer = null;
    }

    if (!shouldAutoRefreshQuota()) {
      return;
    }

    quotaRefreshTimer = setInterval(() => {
      void refreshDueQuotasInBackground(statusBarItem);
    }, QUOTA_SCHEDULER_POLL_INTERVAL_MS);

    if (typeof quotaRefreshTimer.unref === "function") {
      quotaRefreshTimer.unref();
    }
  };

  schedule();
  void refreshDueQuotasInBackground(statusBarItem);

  return {
    schedule,
    dispose() {
      if (quotaRefreshTimer) {
        clearInterval(quotaRefreshTimer);
        quotaRefreshTimer = null;
      }
    }
  };
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
    await refreshAllQuotasInBackground(statusBarItem);
    await updateStatusBar(statusBarItem);
    vscode.window.showInformationMessage("Codex 账号状态与配额已刷新。");
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

  const focusDisposable = vscode.window.onDidChangeWindowState((windowState) => {
    if (windowState.focused) {
      void updateStatusBar(statusBarItem);
    }
  });

  const authWatcherDisposable = createAuthWatcher(statusBarItem);
  const quotaRefreshScheduler = createQuotaRefreshScheduler(statusBarItem);
  const quotaRefreshTimerDisposable = new vscode.Disposable(() => {
    quotaRefreshScheduler.dispose();
  });
  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(CONFIG_SECTION)) {
      return;
    }

    quotaRefreshScheduler.schedule();
  });

  context.subscriptions.push(
    statusBarItem,
    switchDisposable,
    refreshDisposable,
    deleteAccountDisposable,
    applyPatchDisposable,
    restorePatchDisposable,
    focusDisposable,
    authWatcherDisposable,
    configChangeDisposable,
    quotaRefreshTimerDisposable
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
