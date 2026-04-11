"use strict";

const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");

const CODEX_EXTENSION_ID = "openai.chatgpt";
const PATCH_COMMAND_ID = "chatgpt.reloadCodexProcess";
const PATCH_MARKER = PATCH_COMMAND_ID;
const DEFAULT_MAIN_RELATIVE_PATH = path.join("out", "extension.js");

const patchSteps = [
  {
    label: "reload-helper",
    regex: /let ([A-Za-z$_][\w$]*)=([A-Za-z$_][\w$]*)\.startCodexProcess\(\);!\1\.success&&\1\.errorMessage&&([A-Za-z$_][\w$]*)\(\)\.error\(\1\.errorMessage\);/,
    replace: (match, _resultVar, processManagerVar, loggerFactoryVar) =>
      `${match}let reloadCodexProcess=async()=>{let codexReloadResult=${processManagerVar}.startCodexProcess();return!codexReloadResult.success&&codexReloadResult.errorMessage&&${loggerFactoryVar}().error(codexReloadResult.errorMessage),codexReloadResult};`
  },
  {
    label: "sidebar-webview-dispose-before-reinit",
    regex: /(e\.options=\{enableScripts:!0,enableCommandUris:!1,localResourceRoots:\[[A-Za-z$_][\w$]*\]\};)(let [A-Za-z$_][\w$]*=e\.onDidReceiveMessage\([A-Za-z$_][\w$]*=>\{)/,
    replace: (_match, prefix, suffix) =>
      `${prefix}this.__codexSidebarMessageDisposable&&r==="sidebar"&&this.__codexSidebarMessageDisposable.dispose();${suffix}`
  },
  {
    label: "sidebar-webview-disposable-store",
    regex: /(}this\.handleMessage\(e,[A-Za-z$_][\w$]*\)\}\);)this\.subscriptions\.push\(([A-Za-z$_][\w$]*)\),e\.html=await this\.getWebviewContent\(e\)\}onPanelReady\(e\)\{/,
    replace: (_match, prefix, messageDisposableVar) =>
      `${prefix}r==="sidebar"?this.__codexSidebarMessageDisposable=${messageDisposableVar}:this.subscriptions.push(${messageDisposableVar}),e.html=await this.getWebviewContent(e)}onPanelReady(e){`
  },
  {
    label: "reload-helpers",
    regex: /let ([A-Za-z$_][\w$]*)=new ([A-Za-z$_][\w$]*)\(([\s\S]*?)\);e\.push\(\1\);let ([A-Za-z$_][\w$]*)=new ([A-Za-z$_][\w$]*)\(\1\);if\(e\.push\(([A-Za-z$_][\w$]*)\.window\.registerUriHandler\(\4\)\),e\.push\(\6\.window\.registerWebviewViewProvider\(\2\.viewType,\1,\{webviewOptions:\{retainContextWhenHidden:!0\}\}\)\),/,
    replace: (_match, providerVar, providerClassVar, providerArgs, uriHandlerVar, uriHandlerClassVar, vscodeVar) =>
      `let ${providerVar}=new ${providerClassVar}(${providerArgs});e.push(${providerVar});let closeCodexEditors=async()=>{let codexEditorTabs=[];for(let codexTabGroup of ${vscodeVar}.window.tabGroups.all)for(let codexTab of codexTabGroup.tabs){let codexInput=codexTab.input,isCodexEditor=codexInput&&typeof codexInput=="object"&&"viewType"in codexInput&&codexInput.viewType===${providerClassVar}.customEditorViewType;isCodexEditor&&codexEditorTabs.push(codexTab)}codexEditorTabs.length>0&&await ${vscodeVar}.window.tabGroups.close(codexEditorTabs,!0)},reloadCodexSidebar=async()=>{let codexSidebarWebview=${providerVar}.sidebarView?.webview;if(!codexSidebarWebview)return;${providerVar}.clearPendingRequestsForWebview(codexSidebarWebview),${providerVar}.disposeIpcClientForWebview(codexSidebarWebview),${providerVar}.workerBusMessageHandler.unregisterWebview(codexSidebarWebview),${providerVar}.sidebarWebviewReady=!1,codexSidebarWebview.html='<!DOCTYPE html><html><body style="font-family:sans-serif;padding:16px;color:#888;">Reloading Codex...</body></html>',await new Promise(codexResolve=>setTimeout(codexResolve,150)),await ${providerVar}.initializeWebview(codexSidebarWebview,"sidebar")};let ${uriHandlerVar}=new ${uriHandlerClassVar}(${providerVar});if(e.push(${vscodeVar}.window.registerUriHandler(${uriHandlerVar})),e.push(${vscodeVar}.window.registerWebviewViewProvider(${providerClassVar}.viewType,${providerVar},{webviewOptions:{retainContextWhenHidden:!0}})),`
  },
  {
    label: "reload-command",
    regex: /(e\.push\(([A-Za-z$_][\w$]*)\.commands\.registerCommand\("chatgpt\.openSidebar",([A-Za-z$_][\w$]*)\)\),e\.push\(\2\.commands\.registerCommand\("chatgpt\.openCommandMenu",async\(\)=>\{await \2\.commands\.executeCommand\("workbench\.action\.showCommands"\)\}\)\),)(e\.push\(\2\.commands\.registerCommand\(([^,]+),async)/,
    replace: (_match, prefix, vscodeVar, openSidebarCommandVar, nextRegistrationPrefix) =>
      `${prefix}e.push(${vscodeVar}.commands.registerCommand("${PATCH_COMMAND_ID}",async()=>{try{await closeCodexEditors();let codexReloadResult=await reloadCodexProcess();if(!codexReloadResult.success){${vscodeVar}.window.showErrorMessage(codexReloadResult.errorMessage??"Failed to restart Codex.");return}await reloadCodexSidebar(),await ${openSidebarCommandVar}(),${vscodeVar}.window.setStatusBarMessage("Codex restarted.",3e3)}catch(codexReloadError){${vscodeVar}.window.showErrorMessage(codexReloadError instanceof Error?codexReloadError.message:String(codexReloadError))}})),${nextRegistrationPrefix}`
  }
];

function normalizeMainRelativePath(mainField) {
  if (typeof mainField !== "string" || mainField.trim().length === 0) {
    return DEFAULT_MAIN_RELATIVE_PATH;
  }

  return mainField
    .replace(/^[.][\\/]/, "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(path.sep);
}

function getBackupFileName(targetPath) {
  const extension = path.extname(targetPath) || ".js";
  const baseName = path.basename(targetPath, extension);
  return `${baseName}.original${extension}`;
}

function getCodexExtension() {
  return vscode.extensions.getExtension(CODEX_EXTENSION_ID) || null;
}

function getCodexPaths() {
  const extension = getCodexExtension();
  if (!extension) {
    return null;
  }

  const extensionPath = extension.extensionPath;
  const mainRelativePath = normalizeMainRelativePath(extension.packageJSON?.main);
  const targetPath = path.join(extensionPath, mainRelativePath);
  const backupPath = path.join(path.dirname(targetPath), getBackupFileName(targetPath));

  return {
    extension,
    extensionPath,
    version: extension.packageJSON?.version || null,
    mainRelativePath,
    targetPath,
    backupPath
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readPatchStatus() {
  const paths = getCodexPaths();
  if (!paths) {
    return {
      installed: false,
      patched: false,
      backupExists: false,
      targetExists: false,
      version: null,
      extensionPath: null,
      targetPath: null,
      backupPath: null,
      mainRelativePath: null
    };
  }

  const targetExists = await pathExists(paths.targetPath);
  if (!targetExists) {
    return {
      installed: true,
      patched: false,
      backupExists: await pathExists(paths.backupPath),
      targetExists: false,
      version: paths.version,
      extensionPath: paths.extensionPath,
      targetPath: paths.targetPath,
      backupPath: paths.backupPath,
      mainRelativePath: paths.mainRelativePath
    };
  }

  const source = await fs.readFile(paths.targetPath, "utf8");

  return {
    installed: true,
    patched: source.includes(PATCH_MARKER),
    backupExists: await pathExists(paths.backupPath),
    targetExists: true,
    version: paths.version,
    extensionPath: paths.extensionPath,
    targetPath: paths.targetPath,
    backupPath: paths.backupPath,
    mainRelativePath: paths.mainRelativePath
  };
}

function getRegexMatches(source, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...source.matchAll(new RegExp(regex.source, flags))];
}

function applyPatchStep(source, step) {
  const matches = getRegexMatches(source, step.regex);
  if (matches.length === 0) {
    throw new Error(`Patch anchor not found: ${step.label}`);
  }
  if (matches.length > 1) {
    throw new Error(`Patch anchor is ambiguous: ${step.label} (${matches.length} matches)`);
  }

  const nextSource = source.replace(step.regex, (...args) => step.replace(...args.slice(0, -2)));
  if (nextSource === source) {
    throw new Error(`Patch step produced no changes: ${step.label}`);
  }

  return nextSource;
}

function applyPatchSteps(source) {
  let nextSource = source;
  for (const step of patchSteps) {
    nextSource = applyPatchStep(nextSource, step);
  }
  return nextSource;
}

async function ensurePatchTarget(paths) {
  if (await pathExists(paths.targetPath)) {
    return;
  }

  throw new Error(
    `Codex extension entrypoint was not found at ${paths.targetPath}. The installed version may no longer expose a patchable JavaScript entrypoint.`
  );
}

async function applyPatch() {
  const paths = getCodexPaths();
  if (!paths) {
    throw new Error("Official Codex extension was not found.");
  }

  await ensurePatchTarget(paths);

  let source = await fs.readFile(paths.targetPath, "utf8");
  if (source.includes(PATCH_MARKER)) {
    return {
      changed: false,
      version: paths.version,
      targetPath: paths.targetPath,
      backupPath: paths.backupPath
    };
  }

  source = applyPatchSteps(source);

  if (!(await pathExists(paths.backupPath))) {
    await fs.copyFile(paths.targetPath, paths.backupPath);
  }

  await fs.writeFile(paths.targetPath, source, "utf8");
  return {
    changed: true,
    version: paths.version,
    targetPath: paths.targetPath,
    backupPath: paths.backupPath
  };
}

async function restorePatch() {
  const paths = getCodexPaths();
  if (!paths) {
    throw new Error("Official Codex extension was not found.");
  }

  if (!(await pathExists(paths.backupPath))) {
    throw new Error("Patch backup was not found.");
  }

  await fs.copyFile(paths.backupPath, paths.targetPath);
  return {
    changed: true,
    version: paths.version,
    targetPath: paths.targetPath,
    backupPath: paths.backupPath
  };
}

module.exports = {
  PATCH_COMMAND_ID,
  applyPatch,
  readPatchStatus,
  restorePatch
};
