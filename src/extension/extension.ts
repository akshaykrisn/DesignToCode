import * as vscode from 'vscode';
import { OnboardingPanel } from '../panels/OnboardingPanel';
import { ContributePanel } from '../panels/ContributePanel';
import { HomePanel } from '../panels/HomePanel';

const ONBOARDING_SHOWN_KEY = 'skillsOnboard.onboardingShown';

export function activate(context: vscode.ExtensionContext) {
  // Register the Home sidebar view
  const homeProvider = new HomePanel(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(HomePanel.viewType, homeProvider));

  // Register manual trigger command
  const startCmd = vscode.commands.registerCommand('skillsOnboard.start', () => {
    OnboardingPanel.createOrShow(context);
  });
  context.subscriptions.push(startCmd);

  const contributeCmd = vscode.commands.registerCommand('skillsOnboard.contribute', () => {
    ContributePanel.createOrShow(context);
  });
  context.subscriptions.push(contributeCmd);

  // Auto-launch on first install
  const hasShown = context.globalState.get<boolean>(ONBOARDING_SHOWN_KEY, false);
  if (!hasShown) {
    context.globalState.update(ONBOARDING_SHOWN_KEY, true);
    // Slight delay to let VS Code finish loading
    setTimeout(() => {
      vscode.commands.executeCommand('skillsOnboard.homeView.focus');
    }, 1500);
  }
}

export function deactivate() {}
