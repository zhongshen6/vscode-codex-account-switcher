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
    after: `let m=new q_(d);e.push(m);let g=sFe(d,u,m,l,e),v=BZ(d),b=new Ma("vscode",r),S=new K_,R=new Nv,k=new af(R),codexReloadTurnCompleteHandler=B=>{B.method==="turn/completed"&&R.emit("turnComplete")},reloadCodexProcess=async()=>{let B=d.startCodexProcess();return!B.success&&B.errorMessage&&K().error(B.errorMessage),B};e.push(it.window.onDidChangeWindowState(B=>{if(!B.focused){R.emit("background");return}R.emit("foreground")})),e.push(d.registerInternalNotificationHandler(codexReloadTurnCompleteHandler));let C=new V_;`
  },
  {
    label: "conversation-preview-loader-disposable",
    before: `constructor(e,r){this.codexMcpConnection=e;this.globalState=r;e.registerProvider(N5,{onResult:n=>this.handleResult(n)})}nextRequestId=1;`,
    after: `constructor(e,r){this.codexMcpConnection=e;this.globalState=r;this.providerDisposable=e.registerProvider(N5,{onResult:n=>this.handleResult(n)})}providerDisposable;nextRequestId=1;`
  },
  {
    label: "conversation-preview-loader-dispose-method",
    before: `return this.codexMcpConnection.sendRequest(N5,r,"thread/list",o),n}};`,
    after: `return this.codexMcpConnection.sendRequest(N5,r,"thread/list",o),n}dispose(){this.providerDisposable?.dispose(),this.callbacks.clear()}};`
  },
  {
    label: "preview-loader-subscription",
    before: `let S=this.sharedObjectRepository.addSubscriber((R,k)=>{this.broadcastToAllViews({type:"shared-object-updated",key:R,value:k})});this.subscriptions.push(Re.Disposable.from({dispose:S})),this.previewLoader=new n_(this.codexMcpConnection,this.globalState),this.ensureRestoredConversationTabsResolved()}`,
    after: `let S=this.sharedObjectRepository.addSubscriber((R,k)=>{this.broadcastToAllViews({type:"shared-object-updated",key:R,value:k})});this.subscriptions.push(Re.Disposable.from({dispose:S})),this.previewLoader=new n_(this.codexMcpConnection,this.globalState),this.subscriptions.push(this.previewLoader),this.ensureRestoredConversationTabsResolved()}`
  },
  {
    label: "initialize-webview-sidebar-reloadable",
    before: `async initializeWebview(e,r,n){this.registerIpcClientForWebview(e),this.workerBusMessageHandler.registerWebview(e);let o=Re.Uri.joinPath(this.extensionUri,"webview");e.options={enableScripts:!0,enableCommandUris:!1,localResourceRoots:[o]};let i=e.onDidReceiveMessage(s=>{`,
    after: `async initializeWebview(e,r,n){this.registerIpcClientForWebview(e),this.workerBusMessageHandler.registerWebview(e);let o=Re.Uri.joinPath(this.extensionUri,"webview");e.options={enableScripts:!0,enableCommandUris:!1,localResourceRoots:[o]};this.__codexSidebarMessageDisposable&&r==="sidebar"&&this.__codexSidebarMessageDisposable.dispose();let i=e.onDidReceiveMessage(s=>{`
  },
  {
    label: "initialize-webview-sidebar-disposable-store",
    before: `}this.handleMessage(e,s)});this.subscriptions.push(i),e.html=await this.getWebviewContent(e)}onPanelReady(e){`,
    after: `}this.handleMessage(e,s)});r==="sidebar"?this.__codexSidebarMessageDisposable=i:this.subscriptions.push(i),e.html=await this.getWebviewContent(e)}onPanelReady(e){`
  },
  {
    label: "codex-ui-recreate",
    before: `let C=new V_;e.push(C);let P=new Z_(b,C);e.push(P);let U=new W_(v,d,C,l,u,a,b,S,k),te=new Qw(v,U,c),Te=new Pw,Se=Ai().version,ke=e_(),Ie=new Mb({source:"codex-extension",env:ke,codexAppSessionId:n,buildInfo:{version:Se,buildNumber:null},reportFailure:B=>{Il.captureException(new Error(\`[datadog] log sink failure (\${B.type}: \${B.reason})\`))}});NZ(Ie);let Ot=new Ja(t.extensionUri,d,te,u,m,g??void 0,l,Te,Ie,k,r,b,S,Se,n,ke);e.push(Ot);let st=new _x(Ot);if(e.push(it.window.registerUriHandler(st)),e.push(it.window.registerWebviewViewProvider(Ja.viewType,Ot,{webviewOptions:{retainContextWhenHidden:!0}})),Ww(it.version)&&e.push(it.window.registerWebviewViewProvider(Ja.secondaryViewType,Ot,{webviewOptions:{retainContextWhenHidden:!0}})),e.push(it.window.registerCustomEditorProvider(Ja.customEditorViewType,Ot,{webviewOptions:{retainContextWhenHidden:!0},supportsMultipleEditorsPerDocument:!1})),e.push(it.commands.registerCommand("chatgpt.openSidebar",Uo)),`,
    after: `let C=new V_;e.push(C);let P=new Z_(b,C);e.push(P);let U=new W_(v,d,C,l,u,a,b,S,k),te=new Qw(v,U,c),Te=new Pw,Se=Ai().version,ke=e_(),Ie=new Mb({source:"codex-extension",env:ke,codexAppSessionId:n,buildInfo:{version:Se,buildNumber:null},reportFailure:B=>{Il.captureException(new Error(\`[datadog] log sink failure (\${B.type}: \${B.reason})\`))}});NZ(Ie);let Ot=new Ja(t.extensionUri,d,te,u,m,g??void 0,l,Te,Ie,k,r,b,S,Se,n,ke);e.push(Ot);let closeCodexEditors=async()=>{let B=[];for(let Le of it.window.tabGroups.all)for(let Ge of Le.tabs){let ze=Ge.input,je=ze&&typeof ze=="object"&&"viewType"in ze&&ze.viewType===Ja.customEditorViewType;je&&B.push(Ge)}B.length>0&&await it.window.tabGroups.close(B,!0)},reloadCodexSidebar=async()=>{let B=Ot.sidebarView?.webview;if(!B)return;Ot.clearPendingRequestsForWebview(B),Ot.disposeIpcClientForWebview(B),Ot.workerBusMessageHandler.unregisterWebview(B),Ot.sidebarWebviewReady=!1,B.html='<!DOCTYPE html><html><body style="font-family:sans-serif;padding:16px;color:#888;">Reloading Codex...</body></html>',await new Promise(Le=>setTimeout(Le,150)),await Ot.initializeWebview(B,"sidebar")};let st=new _x(Ot);if(e.push(it.window.registerUriHandler(st)),e.push(it.window.registerWebviewViewProvider(Ja.viewType,Ot,{webviewOptions:{retainContextWhenHidden:!0}})),Ww(it.version)&&e.push(it.window.registerWebviewViewProvider(Ja.secondaryViewType,Ot,{webviewOptions:{retainContextWhenHidden:!0}})),e.push(it.window.registerCustomEditorProvider(Ja.customEditorViewType,Ot,{webviewOptions:{retainContextWhenHidden:!0},supportsMultipleEditorsPerDocument:!1})),e.push(it.commands.registerCommand("chatgpt.openSidebar",Uo)),`
  },
  {
    label: "reload-command",
    before: `e.push(it.commands.registerCommand("chatgpt.openSidebar",Uo)),e.push(it.commands.registerCommand("chatgpt.openCommandMenu",async()=>{await it.commands.executeCommand("workbench.action.showCommands")})),e.push(it.commands.registerCommand(tFe,async B=>{`,
    after: `e.push(it.commands.registerCommand("chatgpt.openSidebar",Uo)),e.push(it.commands.registerCommand("chatgpt.openCommandMenu",async()=>{await it.commands.executeCommand("workbench.action.showCommands")})),e.push(it.commands.registerCommand(aFe,async()=>{try{await closeCodexEditors();let B=await reloadCodexProcess();if(!B.success){it.window.showErrorMessage(B.errorMessage??"Failed to restart Codex.");return}await reloadCodexSidebar(),await Uo(),it.window.setStatusBarMessage("Codex restarted.",3e3)}catch(B){it.window.showErrorMessage(B instanceof Error?B.message:String(B))}})),e.push(it.commands.registerCommand(tFe,async B=>{`
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
