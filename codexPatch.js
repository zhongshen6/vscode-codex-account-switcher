"use strict";

const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");

const CODEX_EXTENSION_ID = "openai.chatgpt";
const PATCH_COMMAND_ID = "chatgpt.reloadCodexProcess";
const PATCH_MARKER = PATCH_COMMAND_ID;
const BACKUP_FILE_NAME = "extension.original.js";

const replacements = [
  {
    label: "command-constant",
    before: `var eFe="chatgpt.newChat",tFe="chatgpt.newCodexPanel",rFe="chatgpt.showLspMcpCliArgs",nFe="chatgpt.lspMcpEnabled",oFe="sessionsViewPromotion";`,
    after: `var eFe="chatgpt.newChat",tFe="chatgpt.newCodexPanel",rFe="chatgpt.showLspMcpCliArgs",aFe="chatgpt.reloadCodexProcess",nFe="chatgpt.lspMcpEnabled",oFe="sessionsViewPromotion";`
  },
  {
    label: "turn-complete-handler",
    before: `let m=new q_(d);e.push(m);let g=sFe(d,u,m,l,e),v=BZ(d),b=new Ma("vscode",r),S=new K_,R=new Nv,k=new af(R);e.push(it.window.onDidChangeWindowState(B=>{if(!B.focused){R.emit("background");return}R.emit("foreground")})),e.push(d.registerInternalNotificationHandler(B=>{B.method==="turn/completed"&&R.emit("turnComplete")}));let C=new V_;`,
    after: `let m=new q_(d);e.push(m);let g=sFe(d,u,m,l,e),v=BZ(d),b=new Ma("vscode",r),S=new K_,R=new Nv,k=new af(R),codexReloadTurnCompleteHandler=B=>{B.method==="turn/completed"&&R.emit("turnComplete")},reloadCodexProcess=async()=>{let B=d.startCodexProcess();return!B.success&&B.errorMessage&&K().error(B.errorMessage),B.success&&d.registerInternalNotificationHandler(codexReloadTurnCompleteHandler),B};e.push(it.window.onDidChangeWindowState(B=>{if(!B.focused){R.emit("background");return}R.emit("foreground")})),e.push(d.registerInternalNotificationHandler(codexReloadTurnCompleteHandler));let C=new V_;`
  },
  {
    label: "reload-command",
    before: `e.push(it.commands.registerCommand("chatgpt.openSidebar",Uo)),e.push(it.commands.registerCommand("chatgpt.openCommandMenu",async()=>{await it.commands.executeCommand("workbench.action.showCommands")})),e.push(it.commands.registerCommand(tFe,async B=>{`,
    after: `e.push(it.commands.registerCommand("chatgpt.openSidebar",Uo)),e.push(it.commands.registerCommand("chatgpt.openCommandMenu",async()=>{await it.commands.executeCommand("workbench.action.showCommands")})),e.push(it.commands.registerCommand(aFe,async()=>{let B=await reloadCodexProcess();B.success?it.window.setStatusBarMessage("Codex process reloaded.",3e3):it.window.showErrorMessage(B.errorMessage??"Failed to reload Codex process.");})),e.push(it.commands.registerCommand(tFe,async B=>{`
  }
];

function getCodexExtension() {
  return vscode.extensions.getExtension(CODEX_EXTENSION_ID) || null;
}

function getCodexPaths() {
  const extension = getCodexExtension();
  if (!extension) {
    return null;
  }

  const extensionPath = extension.extensionPath;
  const targetPath = path.join(extensionPath, "out", "extension.js");
  const backupPath = path.join(extensionPath, "out", BACKUP_FILE_NAME);

  return {
    extension,
    extensionPath,
    version: extension.packageJSON?.version || null,
    targetPath,
    backupPath
  };
}

async function readPatchStatus() {
  const paths = getCodexPaths();
  if (!paths) {
    return {
      installed: false,
      patched: false,
      backupExists: false,
      version: null,
      extensionPath: null,
      targetPath: null,
      backupPath: null
    };
  }

  const source = await fs.readFile(paths.targetPath, "utf8");
  let backupExists = false;
  try {
    await fs.access(paths.backupPath);
    backupExists = true;
  } catch {
    backupExists = false;
  }

  return {
    installed: true,
    patched: source.includes(PATCH_MARKER),
    backupExists,
    version: paths.version,
    extensionPath: paths.extensionPath,
    targetPath: paths.targetPath,
    backupPath: paths.backupPath
  };
}

async function applyPatch() {
  const paths = getCodexPaths();
  if (!paths) {
    throw new Error("Official Codex extension was not found.");
  }

  let source = await fs.readFile(paths.targetPath, "utf8");
  if (source.includes(PATCH_MARKER)) {
    return {
      changed: false,
      version: paths.version,
      targetPath: paths.targetPath,
      backupPath: paths.backupPath
    };
  }

  for (const replacement of replacements) {
    if (!source.includes(replacement.before)) {
      throw new Error(`Patch anchor not found: ${replacement.label}`);
    }
    source = source.replace(replacement.before, replacement.after);
  }

  try {
    await fs.access(paths.backupPath);
  } catch {
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

  try {
    await fs.access(paths.backupPath);
  } catch {
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
