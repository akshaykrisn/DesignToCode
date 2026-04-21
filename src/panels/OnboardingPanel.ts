import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ─── Message types ────────────────────────────────────────────────────────────
interface WebviewMessage {
  command: string;
  payload?: unknown;
}

interface FileStatus {
  path: string;
  exists: boolean;
}

// ─── Panel ───────────────────────────────────────────────────────────────────
export class OnboardingPanel {
  public static currentPanel: OnboardingPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];
  private _lmCancel: vscode.CancellationTokenSource | undefined;

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;

    this._panel.webview.html = this._buildHtml(this._panel.webview);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._handleMessage(msg),
      null,
      this._disposables
    );
  }

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.ViewColumn.One;
    if (OnboardingPanel.currentPanel) {
      OnboardingPanel.currentPanel._panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'skillsOnboard',
      'Skills Onboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, '.github'),
        ],
      }
    );
    OnboardingPanel.currentPanel = new OnboardingPanel(panel, context);
  }

  // ─── Message handler ───────────────────────────────────────────────────────
  private async _handleMessage(msg: WebviewMessage) {
    switch (msg.command) {
      case 'startAnalysis':
        await this._runAnalysis();
        break;
      case 'extractFiles':
        await this._extractFiles(msg.payload as string);
        break;
      case 'verifyFiles':
        await this._verifyFiles(msg.payload as string);
        break;
      case 'openFolder':
        await vscode.commands.executeCommand('revealFileInOS',
          vscode.Uri.file(msg.payload as string));
        break;
      case 'close':
        this._panel.dispose();
        break;
      case 'saveConfluenceConfig':
        const config = msg.payload as { url: string; email: string; token: string };
        await this._context.globalState.update('skillsOnboard.confluenceUrl', config.url);
        await this._context.globalState.update('skillsOnboard.confluenceEmail', config.email);
        await this._context.secrets.store('skillsOnboard.confluenceToken', config.token);
        break;
    }
  }

  // ─── Step 2: Analysis via vscode.lm ───────────────────────────────────────
  private async _runAnalysis() {
    this._lmCancel?.cancel();
    this._lmCancel = new vscode.CancellationTokenSource();
    const token = this._lmCancel.token;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const send = (message: string, done = false, result?: object) =>
      this._panel.webview.postMessage({ command: 'analysisUpdate', message, done, result });

    try {
      // Quick filesystem scan before LM call
      send('🔍 Scanning repository structure...');
      await delay(400);

      const repoMeta = await this._scanRepo(workspaceRoot);
      send(`📦 Detected: ${repoMeta.summary}`);
      await delay(300);

      send('🤖 Connecting to Copilot...');

      // Try to get an LM model (requires GitHub Copilot)
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });

      if (!models.length) {
        // Graceful fallback without LM
        send('⚡ Running heuristic analysis (Copilot not available)...');
        await delay(600);
        const heuristic = this._heuristicPlacement(repoMeta);
        send(`✅ Best placement identified: ${heuristic.path}`, true, heuristic);
        return;
      }

      const model = models[0];
      send(`🧠 Asking ${model.name} for placement strategy...`);

      const prompt = vscode.LanguageModelChatMessage.User(
        `You are analyzing a software repository to determine the best location to place agent skill files (SKILL.md folders) and agent definition files (.agent.md).

Repository info:
${JSON.stringify(repoMeta, null, 2)}

Existing relevant directories: ${repoMeta.existingDirs.join(', ') || 'none'}

Important: If multiple valid directories exist (like .github and .claude), always prefer .github.

Respond in JSON only. No markdown. Schema:
{
  "path": "relative path for the configuration root like .github or .claude",
  "agentPath": "relative path for agent files like .claude/agents or .github/agents",
  "reason": "one sentence rationale",
  "confidence": "high | medium | low"
}
`
      );

      let raw = '';
      const response = await model.sendRequest([prompt], {}, token);
      for await (const chunk of response.text) {
        raw += chunk;
      }

      send('📐 Parsing placement strategy...');
      await delay(200);

      let result: { path: string; agentPath: string; reason: string; confidence: string };
      try {
        result = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch {
        result = this._heuristicPlacement(repoMeta);
      }

      send(`✅ Strategy ready — confidence: ${result.confidence}`, true, result);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'Cancelled') {
        return;
      }
      send('⚡ Falling back to heuristic analysis...');
      const workspaceRoot2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const repoMeta2 = await this._scanRepo(workspaceRoot2);
      const fallback = this._heuristicPlacement(repoMeta2);
      send(`✅ Strategy ready — confidence: ${fallback.confidence}`, true, fallback);
    }
  }

  // ─── Step 3: Extract bundled skills into workspace ─────────────────────────
  private async _extractFiles(targetRelPath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      this._panel.webview.postMessage({
        command: 'extractionResult',
        success: false,
        error: 'No workspace folder open.',
      });
      return;
    }

    // Save target path for the Contribute panel to use later
    await this._context.globalState.update('skillsOnboard.targetPath', targetRelPath);

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const skillsSrc = path.join(this._context.extensionPath, '.github');
    const skillsDest = path.join(workspaceRoot, targetRelPath);

    const copied: string[] = [];
    try {
      await fsCopyDir(skillsSrc, skillsDest, copied, workspaceRoot);
      this._panel.webview.postMessage({ command: 'extractionResult', success: true, files: copied });
    } catch (e: unknown) {
      this._panel.webview.postMessage({
        command: 'extractionResult',
        success: false,
        error: String(e),
      });
    }
  }

  // ─── Step 4: Verify ────────────────────────────────────────────────────────
  private async _verifyFiles(targetRelPath: string) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this._panel.webview.postMessage({ command: 'verificationResult', success: false, files: [] });
      return;
    }

    const skillsSrc = path.join(this._context.extensionPath, '.github');
    const checks = listSkillFiles(skillsSrc).map((rel) => {
      const full = path.join(workspaceRoot, targetRelPath, rel);
      return { path: path.join(targetRelPath, rel), exists: fs.existsSync(full) } as FileStatus;
    });

    const allGood = checks.every((c) => c.exists);
    this._panel.webview.postMessage({ command: 'verificationResult', success: allGood, files: checks });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  private async _scanRepo(root?: string): Promise<RepoMeta> {
    if (!root) {
      return { summary: 'No workspace open', type: 'unknown', existingDirs: [], hasGit: false };
    }

    const hasGit = fs.existsSync(path.join(root, '.git'));
    const hasPkg = fs.existsSync(path.join(root, 'package.json'));
    const hasPyProject = fs.existsSync(path.join(root, 'pyproject.toml'));
    const hasCargo = fs.existsSync(path.join(root, 'Cargo.toml'));
    const hasGo = fs.existsSync(path.join(root, 'go.mod'));

    const relevantDirs = ['.github', '.claude', '.agents', '.copilot', '.github/skills', '.claude/skills'];
    const existingDirs = relevantDirs.filter((d) => fs.existsSync(path.join(root, d)));

    const type = hasPkg ? 'node' : hasPyProject ? 'python' : hasCargo ? 'rust' : hasGo ? 'go' : 'generic';
    const summary = `${type} project${hasGit ? ', git repo' : ''}${existingDirs.length ? `, has: ${existingDirs.join(', ')}` : ''}`;

    return { summary, type, existingDirs, hasGit };
  }

  private _heuristicPlacement(meta: RepoMeta): { path: string; agentPath: string; reason: string; confidence: string } {
    if (meta.existingDirs.includes('.github')) {
      return { path: '.github', agentPath: '.github/agents', reason: 'Existing .github directory — standard Copilot location', confidence: 'high' };
    }
    if (meta.existingDirs.includes('.claude/skills')) {
      return { path: '.claude', agentPath: '.claude/agents', reason: 'Existing .claude directory detected', confidence: 'high' };
    }
    return { path: '.github', agentPath: '.github/agents', reason: 'Default cross-agent compatible location', confidence: 'medium' };
  }

  // ─── Dispose ───────────────────────────────────────────────────────────────
  public dispose() {
    this._lmCancel?.cancel();
    OnboardingPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
  }

  // ─── HTML ──────────────────────────────────────────────────────────────────
  private _buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src https://fonts.gstatic.com`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Skills Onboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
  /* ── Reset & base ───────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:          #07090f;
    --surface:     #0d1120;
    --surface2:    #131828;
    --border:      rgba(255,255,255,0.07);
    --border-glow: rgba(59,145,64,0.35);
    --accent:      #3b9140;
    --accent2:     #21792E;
    --accent-dim:  rgba(59,145,64,0.15);
    --text:        #e8ecf4;
    --text-muted:  #6b7a99;
    --text-dim:    #3a4360;
    --success:     #16a34a;
    --warn:        #f5a623;
    --error:       #ff5f6d;
    --radius:      14px;
    --radius-sm:   8px;
    --font-ui:     'Helvetica Neue', Helvetica, Arial, sans-serif;
    --font-mono:   'JetBrains Mono', monospace;
    --transition:  0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  html, body {
    height: 100%; width: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 15px;
    line-height: 1.6;
    overflow: hidden;
  }

  /* ── Layout ─────────────────────────────────────────────────── */
  .shell {
    display: flex; flex-direction: column;
    height: 100vh; width: 100%;
    position: relative;
    overflow: hidden;
  }

  /* Animated background grid */
  .bg-grid {
    position: fixed; inset: 0; z-index: 0;
    background-image:
      linear-gradient(rgba(59,145,64,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(59,145,64,0.05) 1px, transparent 1px);
    background-size: 40px 40px;
    mask-image: radial-gradient(ellipse 80% 80% at 50% 50%, black 30%, transparent 100%);
    animation: gridDrift 20s ease-in-out infinite alternate;
  }
  @keyframes gridDrift {
    from { transform: translate(0, 0); }
    to   { transform: translate(8px, 8px); }
  }

  /* Glow orbs */
  .orb { position: fixed; border-radius: 50%; filter: blur(80px); z-index: 0; pointer-events: none; }
  .orb-1 { width: 500px; height: 500px; top: -100px; left: -100px; background: radial-gradient(circle, rgba(59,145,64,0.12), transparent 70%); animation: orbFloat 12s ease-in-out infinite alternate; }
  .orb-2 { width: 400px; height: 400px; bottom: -80px; right: -80px; background: radial-gradient(circle, rgba(22,163,74,0.10), transparent 70%); animation: orbFloat 15s ease-in-out infinite alternate-reverse; }
  @keyframes orbFloat { from { transform: translate(0, 0) scale(1); } to { transform: translate(30px, -20px) scale(1.1); } }

  .content { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; }

  /* ── Header ─────────────────────────────────────────────────── */
  .header {
    padding: 28px 40px 0;
    display: flex; align-items: center; gap: 14px;
    animation: fadeDown 0.6s var(--transition) both;
  }
  .logo {
    width: 36px; height: 36px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
    box-shadow: 0 0 20px rgba(59,145,64,0.4);
  }
  .header-title { font-size: 15px; font-weight: 500; color: var(--text-muted); letter-spacing: 0.01em; }

  /* ── Stepper ─────────────────────────────────────────────────── */
  .stepper {
    padding: 32px 40px 0;
    animation: fadeDown 0.6s 0.1s var(--transition) both;
  }
  .stepper-track {
    display: flex; align-items: center; position: relative;
  }
  .step-item {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    flex: 1; position: relative; cursor: default;
  }
  .step-circle {
    width: 36px; height: 36px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700;
    border: 2px solid var(--text-dim);
    color: var(--text-dim);
    background: var(--surface);
    transition: all 0.5s cubic-bezier(0.16,1,0.3,1);
    position: relative; z-index: 2;
  }
  .step-circle.active {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-dim);
    box-shadow: 0 0 0 6px rgba(59,145,64,0.12), 0 0 20px rgba(59,145,64,0.3);
  }
  .step-circle.done {
    border-color: var(--accent2);
    background: rgba(33,121,46,0.15);
    color: var(--accent2);
    box-shadow: 0 0 16px rgba(33,121,46,0.25);
  }
  .step-label {
    font-size: 11px; font-weight: 500; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-dim);
    transition: color 0.4s;
    white-space: nowrap;
  }
  .step-item.active .step-label { color: var(--accent); }
  .step-item.done  .step-label { color: var(--accent2); }

  /* Connector line between steps */
  .step-connector {
    flex: 1; height: 2px; margin: 0 4px; margin-bottom: 28px;
    background: var(--text-dim); border-radius: 2px;
    position: relative; overflow: hidden;
    transition: background 0.4s;
  }
  .step-connector.done { background: var(--accent2); }
  .step-connector.active::after {
    content: '';
    position: absolute; top: 0; left: -100%; width: 100%; height: 100%;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    animation: connectorSweep 1.5s ease-in-out infinite;
  }
  @keyframes connectorSweep {
    0%   { left: -100%; }
    100% { left: 100%; }
  }

  /* ── Main stage ──────────────────────────────────────────────── */
  .stage {
    flex: 1; padding: 32px 40px 36px;
    display: flex; justify-content: center;
    overflow-y: auto; overflow-x: hidden;
  }
  .step-page {
    width: 100%; max-width: 660px; margin: auto 0;
    display: none; flex-direction: column; gap: 24px;
    animation: stepIn 0.5s var(--transition) both;
  }
  .step-page.visible { display: flex; }
  @keyframes stepIn {
    from { opacity: 0; transform: translateY(18px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes stepOut {
    from { opacity: 1; transform: translateY(0); }
    to   { opacity: 0; transform: translateY(-14px); }
  }
  .step-page.leaving { animation: stepOut 0.35s var(--transition) both; }

  /* ── Cards ───────────────────────────────────────────────────── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 28px 32px;
  }
  .card.glow {
    border-color: var(--border-glow);
    box-shadow: 0 0 0 1px rgba(59,145,64,0.1) inset, 0 8px 32px rgba(59,145,64,0.06);
  }

  /* ── Typography ──────────────────────────────────────────────── */
  .eyebrow {
    font-size: 11px; font-weight: 600; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--accent);
    display: flex; align-items: center; gap: 8px;
  }
  .eyebrow::before { content:''; width:20px; height:2px; background:var(--accent); border-radius:2px; }
  h1 { font-size: 36px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; color: var(--text); }
  h2 { font-size: 22px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }
  h1 span { background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  p  { color: var(--text-muted); line-height: 1.65; }
  .mono { font-family: var(--font-mono); font-size: 12px; }

  /* ── Feature chips ───────────────────────────────────────────── */
  .chips { display: flex; flex-wrap: wrap; gap: 10px; }
  .chip {
    display: flex; align-items: center; gap: 7px;
    padding: 7px 14px; border-radius: 100px;
    background: var(--surface2); border: 1px solid var(--border);
    font-size: 13px; color: var(--text-muted);
    font-weight: 500;
  }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent2); flex-shrink: 0; }

  /* ── Buttons ─────────────────────────────────────────────────── */
  .btn {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 12px 28px; border-radius: 100px; border: none;
    font-family: var(--font-ui); font-size: 14px; font-weight: 600;
    cursor: pointer; transition: all 0.25s;
    letter-spacing: 0.01em;
  }
  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #fff;
    box-shadow: 0 4px 20px rgba(59,145,64,0.4);
  }
  .btn-primary:hover  { transform: translateY(-1px); box-shadow: 0 8px 28px rgba(59,145,64,0.55); }
  .btn-primary:active { transform: translateY(0); }
  .btn-ghost {
    background: transparent; color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .btn-ghost:hover { border-color: rgba(255,255,255,0.15); color: var(--text); }
  .btn-success {
    background: linear-gradient(135deg, var(--success), #15803d);
    color: #fff;
    box-shadow: 0 4px 20px rgba(22,163,74,0.35);
  }
  .btn-success:hover { transform: translateY(-1px); box-shadow: 0 8px 28px rgba(22,163,74,0.5); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; }
  .btn-row { display: flex; gap: 12px; align-items: center; }

  /* ── Terminal / log pane ─────────────────────────────────────── */
  .terminal {
    background: #050810;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 16px 20px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.8;
    min-height: 120px; max-height: 200px;
    overflow-y: auto;
    color: #8fa3c8;
  }
  .terminal .log-line { display: flex; gap: 10px; }
  .terminal .log-line .ts { color: var(--text-dim); flex-shrink: 0; }
  .terminal .log-line .msg { color: #a8bdd8; }
  .terminal .log-line .msg.ok   { color: var(--accent2); }
  .terminal .log-line .msg.err  { color: var(--error); }
  .terminal::-webkit-scrollbar { width: 4px; }
  .terminal::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

  /* ── Pulsing spinner ─────────────────────────────────────────── */
  .spinner {
    width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Path selector ───────────────────────────────────────────── */
  .path-selector {
    display: flex; gap: 10px; align-items: center;
  }
  .path-input {
    flex: 1; padding: 10px 16px;
    background: #050810; border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono); font-size: 13px;
    color: var(--text); outline: none;
    transition: border-color 0.25s;
  }
  .path-input:focus { border-color: var(--accent); }

  /* ── File list ───────────────────────────────────────────────── */
  .file-list { display: flex; flex-direction: column; gap: 6px; }
  .file-item {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 14px; border-radius: var(--radius-sm);
    background: var(--surface2); border: 1px solid var(--border);
    font-family: var(--font-mono); font-size: 12px; color: var(--text-muted);
    animation: fileAppear 0.4s var(--transition) both;
  }
  .file-item .fi-icon { font-size: 14px; flex-shrink: 0; }
  .file-item .fi-status { margin-left: auto; }
  .fi-ok   { color: var(--accent2); font-size: 14px; }
  .fi-miss { color: var(--error);   font-size: 14px; }
  @keyframes fileAppear { from { opacity:0; transform:translateX(-8px); } to { opacity:1; transform:none; } }

  /* ── Verification summary ────────────────────────────────────── */
  .verify-summary {
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    padding: 28px 20px; text-align: center;
  }
  .verify-icon {
    font-size: 52px;
    animation: popIn 0.5s 0.2s var(--transition) both;
  }
  @keyframes popIn { from { opacity:0; transform:scale(0.4); } to { opacity:1; transform:scale(1); } }

  /* ── Reason badge ────────────────────────────────────────────── */
  .reason-badge {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px 16px; border-radius: var(--radius-sm);
    background: rgba(59,145,64,0.07);
    border: 1px solid rgba(59,145,64,0.18);
    font-size: 13px; color: var(--text-muted);
  }
  .reason-badge .rb-label { color: var(--accent); font-weight: 600; flex-shrink: 0; }

  /* ── Animations ──────────────────────────────────────────────── */
  @keyframes fadeDown { from { opacity:0; transform:translateY(-10px); } to { opacity:1; transform:none; } }

  /* ── Pulse dot ───────────────────────────────────────────────── */
  .pulse-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent);
    animation: pulseDot 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes pulseDot {
    0%, 100% { opacity:1; transform:scale(1); }
    50%       { opacity:0.4; transform:scale(0.6); }
  }

</style>
</head>
<body>
<div class="shell">
  <div class="bg-grid"></div>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>

  <div class="content">

    <!-- Header -->
    <div class="header">
      <div class="logo">⚡</div>
      <span class="header-title">Skills Onboard</span>
    </div>

    <!-- Stepper -->
    <div class="stepper">
      <div class="stepper-track" id="stepperTrack">
        <!-- Rendered by JS -->
      </div>
    </div>

    <!-- Stage -->
    <div class="stage">

      <!-- ─── Step 0: Introduction ─────────────────────────────── -->
      <div class="step-page visible" id="page-0">
        <div>
          <div class="eyebrow">Welcome</div>
          <h1 style="margin-top:10px">Set up your<br/><span>AI agent skills</span></h1>
          <p style="margin-top:16px;max-width:500px">
            This guided setup will analyse your repository, then extract and place
            bundled skill files and agent definitions exactly where your IDE agent
            can find them — automatically.
          </p>
        </div>

        <div class="chips">
          <div class="chip"><span class="dot"></span>Copilot-compatible</div>
          <div class="chip"><span class="dot"></span>Claude Code-compatible</div>
          <div class="chip"><span class="dot"></span>Zero config needed</div>
        </div>

        <div class="card glow" style="display:flex;gap:20px;align-items:flex-start">
          <div style="font-size:24px;flex-shrink:0">🗺️</div>
          <div>
            <div style="font-weight:600;margin-bottom:4px">What happens next</div>
            <p style="font-size:13px">
              We'll run a quick <strong style="color:var(--text)">Copilot-powered analysis</strong> of your repo to
              determine the ideal placement strategy, then copy the bundled skills
              , agents, and instructions with a single click. Finally, we verify everything is
              in the right place.
            </p>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" id="btn-begin">
            Let's begin
          </button>
          <button class="btn btn-ghost" id="btn-close-1">Maybe later</button>
        </div>
      </div>

      <!-- ─── Step 1: Analysis ─────────────────────────────────── -->
      <div class="step-page" id="page-1">
        <div>
          <div class="eyebrow">Step 1 — Analysis</div>
          <h2 style="margin-top:10px">Analysing your repository</h2>
          <p style="margin-top:8px">
            Copilot will scan your project structure and recommend the best
            location to place skill files and agent definitions.
          </p>
        </div>

        <div class="card" id="analysisCard">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
            <div id="analysisDot" class="pulse-dot"></div>
            <span style="font-size:13px;font-weight:600;color:var(--text-muted)" id="analysisStatus">Ready to analyse</span>
          </div>
          <div class="terminal" id="terminal"></div>
        </div>

        <!-- Result card (hidden until analysis done) -->
        <div class="card glow" id="analysisResult" style="display:none">
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <div style="flex:1;min-width:180px">
              <div class="eyebrow" style="margin-bottom:6px">Config path</div>
              <div class="mono" id="resultSkillPath" style="font-size:14px;color:var(--text)"></div>
            </div>
            <div style="flex:1;min-width:180px">
              <div class="eyebrow" style="margin-bottom:6px">Agents path</div>
              <div class="mono" id="resultAgentPath" style="font-size:14px;color:var(--text)"></div>
            </div>
          </div>
          <div class="reason-badge" style="margin-top:14px">
            <span class="rb-label">Why?</span>
            <span id="resultReason"></span>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" id="analyseBtn">
            <div class="spinner" id="analyseSpinner" style="display:none"></div>
            Run analysis
          </button>
          <button class="btn btn-primary" id="toExtractBtn" style="display:none">
            Continue to extraction
          </button>
          <button class="btn btn-ghost" id="btn-back-0">← Back</button>
        </div>
      </div>

      <!-- ─── Step 2: Extraction ───────────────────────────────── -->
      <div class="step-page" id="page-2">
        <div>
          <div class="eyebrow">Step 2 — Extraction</div>
          <h2 style="margin-top:10px">Place files in your repo</h2>
          <p style="margin-top:8px">
            The bundled configuration will be copied into your workspace. Confirm or
            adjust the target path below.
          </p>
        </div>

        <div class="card">
          <div style="margin-bottom:14px;font-weight:600;font-size:14px">Target config directory</div>
          <div class="path-selector">
            <input class="path-input" type="text" id="targetPathInput" value=".github" spellcheck="false"/>
            <button class="btn btn-ghost" id="btn-reset-path" style="padding:10px 18px;border-radius:8px;flex-shrink:0">Reset</button>
          </div>
          <p style="margin-top:10px;font-size:12px;color:var(--text-dim)" id="extractDesc">
            Files will be extracted relative to your workspace root.
          </p>
        </div>

        <div id="extractedFiles" style="display:none">
          <div style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:10px">Extracted files</div>
          <div class="file-list" id="fileList"></div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" id="extractBtn">
            <div class="spinner" id="extractSpinner" style="display:none"></div>
            Extract files
          </button>
          <button class="btn btn-primary" id="toConfBtn" style="display:none">
            Continue to telemetry
          </button>
          <button class="btn btn-ghost" id="btn-back-1">← Back</button>
        </div>
      </div>

      <!-- ─── Step 3: Confluence (Telemetry) ──────────────────── -->
      <div class="step-page" id="page-3">
        <div>
          <div class="eyebrow">Step 3 — Feedback Loop</div>
          <h2 style="margin-top:10px">Link Confluence (Optional)</h2>
          <p style="margin-top:8px">
            Provide your Atlassian account email and an API Token to easily sync your skill improvements
            back to the team's central knowledge base later.
          </p>
        </div>

        <div class="card">
          <div style="margin-bottom:14px;font-weight:600;font-size:14px">Confluence API Setup</div>
          <div class="file-list" style="gap: 14px; background: transparent; border: none; padding: 0;">
            <div>
              <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Confluence Domain (e.g. https://your-domain.atlassian.net)</div>
              <input class="path-input" type="text" id="confUrlInput" style="width:100%" spellcheck="false" placeholder="https://your-domain.atlassian.net"/>
            </div>
            <div>
              <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Atlassian Account Email</div>
              <input class="path-input" type="text" id="confEmailInput" style="width:100%" spellcheck="false" placeholder="you@company.com"/>
            </div>
            <div>
              <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Atlassian API Token</div>
              <input class="path-input" type="password" id="confTokenInput" style="width:100%" spellcheck="false" placeholder="Enter API token..."/>
            </div>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" id="saveConfBtn">Save & Continue</button>
          <button class="btn btn-ghost" id="skipConfBtn">Skip</button>
          <button class="btn btn-ghost" id="btn-back-2">← Back</button>
        </div>
      </div>

      <!-- ─── Step 4: Verification ────────────────────────────── -->
      <div class="step-page" id="page-4">
        <div>
          <div class="eyebrow">Step 3 — Verification</div>
          <h2 style="margin-top:10px">Confirming placement</h2>
          <p style="margin-top:8px">
            Checking that all skill and agent files are present and correctly
            located in your repository.
          </p>
        </div>

        <div id="verifyResult" style="display:none">
          <div class="verify-summary" id="verifySummary"></div>
          <div class="file-list" id="verifyFileList" style="margin-top:8px"></div>
        </div>

        <div class="btn-row" style="margin-top:8px">
          <button class="btn btn-primary" id="verifyBtn">
            <div class="spinner" id="verifySpinner" style="display:none"></div>
            Run verification
          </button>
          <button class="btn btn-success" id="doneBtn" style="display:none">
            ✓ All done!
          </button>
          <button class="btn btn-ghost" id="btn-back-3">← Back</button>
        </div>
      </div>

    </div><!-- /stage -->
  </div><!-- /content -->
</div><!-- /shell -->

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────
  let currentStep = 0;
  let analysisResult = null;

  const STEPS = [
    { label: 'Intro' },
    { label: 'Analysis' },
    { label: 'Extraction' },
    { label: 'Feedback' },
    { label: 'Verification' },
  ];

  // ── Stepper render ─────────────────────────────────────────────
  function renderStepper() {
    const track = document.getElementById('stepperTrack');
    track.innerHTML = '';
    STEPS.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'step-item' +
        (i === currentStep ? ' active' : i < currentStep ? ' done' : '');
      const circle = document.createElement('div');
      circle.className = 'step-circle' +
        (i === currentStep ? ' active' : i < currentStep ? ' done' : '');
      circle.textContent = i < currentStep ? '✓' : String(i + 1);
      const label = document.createElement('div');
      label.className = 'step-label';
      label.textContent = s.label;
      item.appendChild(circle);
      item.appendChild(label);
      track.appendChild(item);
      if (i < STEPS.length - 1) {
        const conn = document.createElement('div');
        conn.className = 'step-connector' +
          (i < currentStep ? ' done' : i === currentStep ? ' active' : '');
        track.appendChild(conn);
      }
    });
  }

  // ── Navigation ─────────────────────────────────────────────────
  function goTo(idx) {
    const from = document.getElementById('page-' + currentStep);
    from.classList.add('leaving');
    setTimeout(() => {
      from.classList.remove('leaving');
      from.classList.remove('visible');
      currentStep = idx;
      const to = document.getElementById('page-' + currentStep);
      to.classList.add('visible');
      renderStepper();
    }, 340);
  }

  // ── Step 1: Analysis ───────────────────────────────────────────
  function startAnalysis() {
    const btn = document.getElementById('analyseBtn');
    const spinner = document.getElementById('analyseSpinner');
    const status = document.getElementById('analysisStatus');
    const terminal = document.getElementById('terminal');
    const resultCard = document.getElementById('analysisResult');
    const toExtractBtn = document.getElementById('toExtractBtn');

    btn.disabled = true;
    spinner.style.display = 'block';
    btn.childNodes[btn.childNodes.length - 1].textContent = ' Analysing...';
    status.textContent = 'Connecting to Copilot...';
    terminal.innerHTML = '';
    resultCard.style.display = 'none';
    toExtractBtn.style.display = 'none';

    document.getElementById('analysisDot').style.animationPlayState = 'running';
    vscode.postMessage({ command: 'startAnalysis' });
  }

  function appendLog(msg, cls) {
    const terminal = document.getElementById('terminal');
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML = \`<span class="ts">\${ts}</span><span class="msg \${cls || ''}">\${escHtml(msg)}</span>\`;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  // ── Step 2: Extraction ─────────────────────────────────────────
  function resetPath() {
    const def = analysisResult ? analysisResult.path : '.github';
    document.getElementById('targetPathInput').value = def;
  }

  function extractFiles() {
    const btn = document.getElementById('extractBtn');
    const spinner = document.getElementById('extractSpinner');
    const toConf = document.getElementById('toConfBtn');
    const targetPath = document.getElementById('targetPathInput').value.trim();

    btn.disabled = true;
    spinner.style.display = 'block';
    btn.childNodes[btn.childNodes.length - 1].textContent = ' Extracting...';
    toConf.style.display = 'none';
    document.getElementById('extractedFiles').style.display = 'none';

    vscode.postMessage({ command: 'extractFiles', payload: targetPath });
  }

  // ── Step 3: Verification ───────────────────────────────────────
  function verifyFiles() {
    const btn = document.getElementById('verifyBtn');
    const spinner = document.getElementById('verifySpinner');
    const targetPath = document.getElementById('targetPathInput').value.trim();

    btn.disabled = true;
    spinner.style.display = 'block';
    btn.childNodes[btn.childNodes.length - 1].textContent = ' Verifying...';
    document.getElementById('verifyResult').style.display = 'none';

    vscode.postMessage({ command: 'verifyFiles', payload: targetPath });
  }

  // ── Message receiver ───────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;

    if (msg.command === 'analysisUpdate') {
      appendLog(msg.message, msg.done ? 'ok' : '');
      if (msg.done && msg.result) {
        analysisResult = msg.result;
        document.getElementById('resultSkillPath').textContent = msg.result.path;
        document.getElementById('resultAgentPath').textContent = msg.result.agentPath;
        document.getElementById('resultReason').textContent = msg.result.reason;
        document.getElementById('analysisResult').style.display = 'block';
        document.getElementById('analysisStatus').textContent = 'Analysis complete';
        document.getElementById('analyseBtn').style.display = 'none';
        document.getElementById('toExtractBtn').style.display = 'inline-flex';
        document.getElementById('analysisDot').style.animationPlayState = 'paused';
        // Pre-fill extraction path
        document.getElementById('targetPathInput').value = msg.result.path;
      } else {
        document.getElementById('analysisStatus').textContent = strip(msg.message);
      }
    }

    if (msg.command === 'extractionResult') {
      const btn = document.getElementById('extractBtn');
      const spinner = document.getElementById('extractSpinner');
      spinner.style.display = 'none';
      btn.childNodes[btn.childNodes.length - 1].textContent = ' Extract files';
      btn.disabled = false;

      if (msg.success) {
        const fileList = document.getElementById('fileList');
        fileList.innerHTML = '';
        (msg.files || []).forEach((f, idx) => {
          const item = document.createElement('div');
          item.className = 'file-item';
          item.style.animationDelay = (idx * 0.06) + 's';
          item.innerHTML = \`<span class="fi-icon">📄</span><span>\${escHtml(f)}</span><span class="fi-status fi-ok">✓</span>\`;
          fileList.appendChild(item);
        });
        document.getElementById('extractedFiles').style.display = 'block';
        document.getElementById('toConfBtn').style.display = 'inline-flex';
        btn.style.display = 'none';
      } else {
        btn.textContent = 'Retry extraction';
        showError('extractDesc', 'Extraction failed: ' + (msg.error || 'Unknown error'));
      }
    }

    if (msg.command === 'verificationResult') {
      const btn = document.getElementById('verifyBtn');
      const spinner = document.getElementById('verifySpinner');
      spinner.style.display = 'none';
      btn.childNodes[btn.childNodes.length - 1].textContent = ' Run verification';
      btn.disabled = false;

      const summary = document.getElementById('verifySummary');
      const fileList = document.getElementById('verifyFileList');
      fileList.innerHTML = '';

      (msg.files || []).forEach((f, idx) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.style.animationDelay = (idx * 0.07) + 's';
        const icon = f.exists ? 'fi-ok">✓' : 'fi-miss">✗';
        item.innerHTML = \`<span class="fi-icon">📄</span><span>\${escHtml(f.path)}</span><span class="fi-status \${icon}</span>\`;
        fileList.appendChild(item);
      });

      if (msg.success) {
        summary.innerHTML = \`
          <div class="verify-icon">🎉</div>
          <h2 style="margin-top:4px">All files verified!</h2>
          <p>Your agent skills are correctly placed and ready to use.<br/>Open the Copilot or Claude Code chat to invoke them.</p>
        \`;
        document.getElementById('doneBtn').style.display = 'inline-flex';
        btn.style.display = 'none';
      } else {
        summary.innerHTML = \`
          <div class="verify-icon">⚠️</div>
          <h2 style="margin-top:4px">Some files missing</h2>
          <p>The files below were not found. Try re-running extraction.</p>
        \`;
      }
      document.getElementById('verifyResult').style.display = 'block';
    }
  });

  // ── Utilities ──────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function strip(s) { return s.replace(/^[^a-zA-Z0-9]+/, '').trim(); }
  function showError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.color = 'var(--error)'; }
  }

  // ── Init ───────────────────────────────────────────────────────
  // Wire up all the buttons
  document.getElementById('btn-begin').addEventListener('click', () => goTo(1));
  document.getElementById('btn-close-1').addEventListener('click', () => vscode.postMessage({command:'close'}));

  document.getElementById('analyseBtn').addEventListener('click', startAnalysis);
  document.getElementById('toExtractBtn').addEventListener('click', () => goTo(2));
  document.getElementById('btn-back-0').addEventListener('click', () => goTo(0));

  document.getElementById('extractBtn').addEventListener('click', extractFiles);
  document.getElementById('btn-reset-path').addEventListener('click', resetPath);
  document.getElementById('toConfBtn').addEventListener('click', () => goTo(3));
  document.getElementById('btn-back-1').addEventListener('click', () => goTo(1));

  document.getElementById('saveConfBtn').addEventListener('click', () => {
    const url = document.getElementById('confUrlInput').value.trim();
    const email = document.getElementById('confEmailInput').value.trim();
    const token = document.getElementById('confTokenInput').value.trim();
    if (url && email && token) { vscode.postMessage({ command: 'saveConfluenceConfig', payload: { url, email, token } }); }
    goTo(4);
  });
  document.getElementById('skipConfBtn').addEventListener('click', () => goTo(4));
  document.getElementById('btn-back-2').addEventListener('click', () => goTo(2));

  document.getElementById('verifyBtn').addEventListener('click', verifyFiles);
  document.getElementById('doneBtn').addEventListener('click', () => vscode.postMessage({command:'close'}));
  document.getElementById('btn-back-3').addEventListener('click', () => goTo(3));

  renderStepper();
</script>
</body>
</html>`;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
interface RepoMeta {
  summary: string;
  type: string;
  existingDirs: string[];
  hasGit: boolean;
}

function delay(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function fsCopyDir(src: string, dest: string, copied: string[], root: string) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fsCopyDir(srcPath, destPath, copied, root);
    } else {
      fs.copyFileSync(srcPath, destPath);
      copied.push(path.relative(root, destPath));
    }
  }
}

function listSkillFiles(dir: string, base = ''): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) { return results; }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) { results.push(...listSkillFiles(path.join(dir, e.name), rel)); }
    else { results.push(rel); }
  }
  return results;
}
