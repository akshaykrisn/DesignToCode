import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Hardcoded page ID as requested
const CONFLUENCE_PAGE_ID = '131286'; 

export class ContributePanel {
  public static currentPanel: ContributePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;

    this._panel.webview.html = this._buildHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage((msg) => this._handleMessage(msg), null, this._disposables);
  }

  public static createOrShow(context: vscode.ExtensionContext) {
    if (ContributePanel.currentPanel) {
      ContributePanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel('skillsContribute', 'Sync Skills', vscode.ViewColumn.One, { enableScripts: true });
    ContributePanel.currentPanel = new ContributePanel(panel, context);
  }

  private async _handleMessage(msg: { command: string; payload?: any }) {
    switch (msg.command) {
      case 'generateDiff':
        await this._generateDiff();
        break;
      case 'syncToConfluence':
        await this._syncToConfluence(msg.payload?.title);
        break;
    }
  }

  private _diffCache: string = '';

  private async _generateDiff() {
    const targetRelPath = this._context.globalState.get<string>('skillsOnboard.targetPath');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspaceRoot || !targetRelPath) {
      this._panel.webview.postMessage({ command: 'diffResult', error: 'Workspace or target path not found. Have you completed onboarding?' });
      return;
    }

    const skillsSrc = path.join(this._context.extensionPath, '.github');
    const skillsDest = path.join(workspaceRoot, targetRelPath);

    try {
      // Using git to diff folders outside of a git repo (no-index)
      await execAsync(`git diff --no-index "${skillsSrc}" "${skillsDest}"`);
      // If git diff returns 0, there are no differences
      this._panel.webview.postMessage({ command: 'diffResult', diff: 'No changes detected.' });
    } catch (e: any) {
      // git diff --no-index exits with 1 if it finds differences (which throws an error in Node)
      if (e.code === 1 && e.stdout) {
        this._diffCache = e.stdout;
        this._panel.webview.postMessage({ command: 'diffResult', diff: e.stdout });
      } else {
        this._panel.webview.postMessage({ command: 'diffResult', error: 'Failed to generate diff. Make sure git is installed.' });
      }
    }
  }

  private async _syncToConfluence(customTitle?: string) {
    if (!this._diffCache) {
      this._panel.webview.postMessage({ command: 'syncResult', success: false, error: 'No diff to sync.' });
      return;
    }

    const url = this._context.globalState.get<string>('skillsOnboard.confluenceUrl');
    const email = this._context.globalState.get<string>('skillsOnboard.confluenceEmail');
    const token = await this._context.secrets.get('skillsOnboard.confluenceToken');

    if (!url || !email || !token) {
      this._panel.webview.postMessage({ command: 'syncResult', success: false, error: 'Confluence configuration missing. Please re-run onboarding.' });
      return;
    }

    try {
      // Handle Atlassian cloud URLs which need /wiki in the path
      const apiBase = url.replace(/\/$/, '') + `/wiki/rest/api/content/${CONFLUENCE_PAGE_ID}`;
      const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
      const headers = {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };

      // 1. Get current page version and content
      const getRes = await fetch(`${apiBase}?expand=version,body.storage`, { headers });
      if (!getRes.ok) {
        const errorText = await getRes.text();
        throw new Error(`GET failed: ${getRes.status} ${getRes.statusText}. Check your Confluence URL, Page ID, and PAT. Response: ${errorText}`);
      }
      const pageData = await getRes.json() as any;

      // 2. Append diff block
      const currentBody = pageData.body.storage.value;
      const mainTitle = customTitle ? customTitle : 'Skill Update';
      const subTitle = `Skill update: ${new Date().toISOString()}`;
      const newBlock = `<br/><h2>${mainTitle}</h2><p><em>${subTitle}</em></p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">diff</ac:parameter><ac:parameter ac:name="theme">Midnight</ac:parameter><ac:plain-text-body><![CDATA[${this._diffCache}]]></ac:plain-text-body></ac:structured-macro>`;

      const updatePayload = {
        version: { number: pageData.version.number + 1 },
        title: pageData.title,
        type: 'page',
        body: { storage: { value: currentBody + newBlock, representation: 'storage' } }
      };

      // 3. Update page
      const putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(updatePayload) });
      if (!putRes.ok) {
        const errorText = await putRes.text();
        throw new Error(`PUT failed: ${putRes.status} ${putRes.statusText}. Response: ${errorText}`);
      }

      this._panel.webview.postMessage({ command: 'syncResult', success: true });
    } catch (e: any) {
      this._panel.webview.postMessage({ command: 'syncResult', success: false, error: String(e) });
    }
  }

  public dispose() {
    ContributePanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
  }

  private _buildHtml(): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sync Skills</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono&display=swap" rel="stylesheet"/>
<style>
  :root { --bg: #07090f; --surface: #0d1120; --border: rgba(255,255,255,0.07); --accent: #3b9140; --success: #16a34a; --text: #e8ecf4; --text-muted: #6b7a99; --error: #ff5f6d; }
  *, *::before, *::after { box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; margin: 0; }
  .container { max-width: 800px; margin: 0 auto; }
  h1 { font-size: 28px; margin-bottom: 10px; }
  p { color: var(--text-muted); margin-bottom: 24px; line-height: 1.5; }
  
  /* GitHub-style Diff View */
  .diff-container { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; font-family: 'JetBrains Mono', monospace; font-size: 13px; min-height: 200px; max-height: 500px; overflow-y: auto; margin-bottom: 24px; display: flex; flex-direction: column; }
  .diff-line { display: flex; min-height: 22px; line-height: 22px; width: 100%; }
  .diff-line:hover .diff-content { background-color: rgba(255,255,255,0.03); }
  .diff-linenum { width: 40px; min-width: 40px; flex-shrink: 0; padding-right: 10px; text-align: right; color: rgba(232, 236, 244, 0.3); font-size: 11px; user-select: none; background: rgba(255,255,255,0.02); }
  .diff-linenum.right { border-right: 1px solid var(--border); }
  .diff-symbol { user-select: none; width: 24px; min-width: 24px; flex-shrink: 0; text-align: center; color: var(--text-muted); font-weight: bold; }
  .diff-content { white-space: pre-wrap; word-break: break-all; padding-right: 16px; flex-grow: 1; color: #c9d1d9; }
  
  .diff-file-header { font-weight: bold; background: #161b22; padding: 8px 16px; position: sticky; top: 0; border-bottom: 1px solid var(--border); color: var(--text); z-index: 10; }
  .diff-header { background: rgba(59, 145, 64, 0.1); color: #7ad87e; padding: 4px 16px; font-size: 12px; }
  
  .diff-addition { background: rgba(46, 160, 67, 0.15); }
  .diff-addition .diff-linenum { background: rgba(46, 160, 67, 0.1); }
  .diff-addition .diff-symbol { color: #3fb950; }
  .diff-addition .diff-content { color: #e6ffec; }
  
  .diff-deletion { background: rgba(248, 81, 73, 0.15); }
  .diff-deletion .diff-linenum { background: rgba(248, 81, 73, 0.1); }
  .diff-deletion .diff-symbol { color: #ff7b72; }
  .diff-deletion .diff-content { color: #ffebe9; }

  .input-text { width: 100%; padding: 10px 16px; background: #050810; border: 1px solid var(--border); border-radius: 8px; font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--text); outline: none; transition: border-color 0.25s; margin-bottom: 24px; }
  .input-text:focus { border-color: var(--accent); }

  .spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin 0.8s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .btn { display: inline-flex; align-items: center; gap: 9px; padding: 12px 24px; border-radius: 100px; border: none; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer; color: #fff; }
  .btn-primary { background: linear-gradient(135deg, var(--accent), #21792E); box-shadow: 0 4px 20px rgba(59, 145, 64, 0.4); }
  .btn-success { background: linear-gradient(135deg, var(--success), #15803d); box-shadow: 0 4px 20px rgba(22, 163, 74, 0.35); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #errorMsg { color: var(--error); margin-top: 12px; font-size: 14px; }
</style>
</head>
<body>
<div class="container">
  <h1>Contribute Skill Updates</h1>
  <p>Review the modifications you've made to the local agent skills compared to the bundled extension defaults. Syncing will append this diff to your team's Confluence knowledge base.</p>
  
  <div>
    <div style="font-size:13px;color:var(--text-muted);font-weight:600;margin-bottom:8px">Change Title</div>
    <input type="text" id="syncTitle" class="input-text" placeholder="e.g. Added edge case handling to example-skill..." />
  </div>

  <div class="diff-container" id="diffView">
    <div style="padding: 16px; color: var(--text-muted);">Calculating diff...</div>
  </div>
  
  <button class="btn btn-primary" id="syncBtn" disabled>
    <div class="spinner" id="syncSpinner" style="display:none"></div>
    <span id="syncBtnText">Sync to Confluence</span>
  </button>
  <div id="errorMsg"></div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const diffView = document.getElementById('diffView');
  const syncBtn = document.getElementById('syncBtn');
  const syncSpinner = document.getElementById('syncSpinner');
  const syncBtnText = document.getElementById('syncBtnText');
  const errorMsg = document.getElementById('errorMsg');

  function renderDiff(diffText) {
    const lines = diffText.split('\\n');
    let html = '';
    let oldLineNum = 0;
    let newLineNum = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line && i === lines.length - 1) continue;
      const escapedLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      
      if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        continue; // Hide raw git metadata lines
      } else if (line.startsWith('diff ')) {
        // Extract just the filename from the diff command
        const fileName = escapedLine.split('/').pop().split('\\\\').pop().replace(/"$/, '');
        html += \`<div class="diff-file-header">📄 \${fileName}</div>\`;
      } else if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
        if (match) {
          oldLineNum = parseInt(match[1], 10);
          newLineNum = parseInt(match[2], 10);
        }
        html += \`<div class="diff-header">\${escapedLine}</div>\`;
      } else if (line.startsWith('\\\\ ')) {
        html += \`<div class="diff-line diff-context"><div class="diff-linenum"></div><div class="diff-linenum right"></div><div class="diff-symbol"></div><div class="diff-content">\${escapedLine}</div></div>\`;
      } else if (line.startsWith('+')) {
        html += \`<div class="diff-line diff-addition"><div class="diff-linenum"></div><div class="diff-linenum right">\${newLineNum}</div><div class="diff-symbol">+</div><div class="diff-content">\${escapedLine.substring(1)}</div></div>\`;
        newLineNum++;
      } else if (line.startsWith('-')) {
        html += \`<div class="diff-line diff-deletion"><div class="diff-linenum">\${oldLineNum}</div><div class="diff-linenum right"></div><div class="diff-symbol">-</div><div class="diff-content">\${escapedLine.substring(1)}</div></div>\`;
        oldLineNum++;
      } else {
        // Context lines
        const content = escapedLine ? escapedLine.substring(1) : '';
        html += \`<div class="diff-line diff-context"><div class="diff-linenum">\${oldLineNum}</div><div class="diff-linenum right">\${newLineNum}</div><div class="diff-symbol"> </div><div class="diff-content">\${content}</div></div>\`;
        oldLineNum++;
        newLineNum++;
      }
    }
    return html;
  }

  // Ask extension to generate diff immediately
  vscode.postMessage({ command: 'generateDiff' });

  syncBtn.addEventListener('click', () => {
    const titleInput = document.getElementById('syncTitle');
    syncBtn.disabled = true;
    syncSpinner.style.display = 'block';
    syncBtnText.textContent = 'Syncing';
    errorMsg.textContent = '';
    vscode.postMessage({ command: 'syncToConfluence', payload: { title: titleInput.value.trim() } });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'diffResult') {
      if (msg.error) {
        diffView.innerHTML = \`<div style="padding: 16px; color: var(--error);">\${msg.error}</div>\`;
      } else {
        if (msg.diff !== 'No changes detected.') {
          diffView.innerHTML = renderDiff(msg.diff);
          syncBtn.disabled = false;
        } else {
          diffView.innerHTML = \`<div style="padding: 16px; color: var(--success);">\${msg.diff}</div>\`;
        }
      }
    }
    if (msg.command === 'syncResult') {
      if (msg.success) {
        syncBtn.className = 'btn btn-success';
        syncSpinner.style.display = 'none';
        syncBtnText.textContent = 'Successfully Synced';
      } else {
        syncBtn.disabled = false;
        syncSpinner.style.display = 'none';
        syncBtnText.textContent = 'Sync to Confluence';
        errorMsg.textContent = 'Error: ' + msg.error;
      }
    }
  });
</script>
</body>
</html>`;
  }
}