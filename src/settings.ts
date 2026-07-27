import * as vscode from 'vscode';

export function isExecutionPlanEnabled(): boolean {
    return vscode.workspace.getConfiguration('exasol').get<boolean>('executionPlan', true) !== false;
}
