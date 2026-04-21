import * as vscode from 'vscode';
import { OnboardingPanel } from '../panels/OnboardingPanel';

const ONBOARDING_SHOWN_KEY = 'skillsOnboard.onboardingShown';

export function activate(context: vscode.ExtensionContext) {
  // Register manual trigger command
  const startCmd = vscode.commands.registerCommand('skillsOnboard.start', () => {
    OnboardingPanel.createOrShow(context);
  });
  context.subscriptions.push(startCmd);

  // Auto-launch on first install
  const hasShown = context.globalState.get<boolean>(ONBOARDING_SHOWN_KEY, false);
  if (!hasShown) {
    context.globalState.update(ONBOARDING_SHOWN_KEY, true);
    // Slight delay to let VS Code finish loading
    setTimeout(() => {
      OnboardingPanel.createOrShow(context);
    }, 1500);
  }
}

export function deactivate() {}
