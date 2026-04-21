import * as vscode from 'vscode';

export class HomePanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'skillsOnboard.homeView';

  private _view?: vscode.WebviewView;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'openOnboarding':
          vscode.commands.executeCommand('skillsOnboard.start');
          break;
        case 'openContribute':
          vscode.commands.executeCommand('skillsOnboard.contribute');
          break;
      }
    });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Skills Onboard - Home</title>
<style>
  /* ── Reset & base ───────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:          var(--vscode-sideBar-background);
    --surface:     var(--vscode-input-background);
    --border:      var(--vscode-sideBar-border, var(--vscode-contrastBorder));
    --accent:      #3b9140;
    --text:        var(--vscode-foreground);
    --text-muted:  var(--vscode-descriptionForeground);
    --radius-sm:   8px;
    --font-ui:     'Helvetica Neue', Helvetica, Arial, sans-serif;
  }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 13px;
    padding: 16px;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }

  .logo {
    width: 32px; height: 32px;
    background: var(--accent);
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px;
    color: white;
  }
  
  .header-text h1 { font-size: 16px; font-weight: 600; }
  .header-text p { font-size: 12px; color: var(--text-muted); margin-top: 2px; line-height: 1.4; }
  
  .action-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 24px;
  }
  
  .action-button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.2s, border-color 0.2s;
  }
  
  .action-button:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--accent);
  }
  
  .action-button .icon {
    font-size: 18px;
    color: var(--accent);
  }
</style>
</head>
<body>

  <div class="header">
    <div class="logo">⚡</div>
    <div class="header-text">
      <h1>Skills Onboard</h1>
      <p>Setup and sync AI agent skills for your repository.</p>
    </div>
  </div>

  <div class="action-list">
    <button class="action-button" id="btn-onboard">
      <span class="icon">🚀</span>
      <span>Setup Workspace</span>
    </button>
    <button class="action-button" id="btn-contribute">
      <span class="icon">🔄</span>
      <span>Sync Skill Updates</span>
    </button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  document.getElementById('btn-onboard').addEventListener('click', () => {
    vscode.postMessage({ command: 'openOnboarding' });
  });

  document.getElementById('btn-contribute').addEventListener('click', () => {
    vscode.postMessage({ command: 'openContribute' });
  });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}