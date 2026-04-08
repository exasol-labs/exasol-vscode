import * as assert from 'assert';
import { formatDuration } from '../../utils';

// Track calls to mock notification methods
const windowCalls: { method: string; args: any[] }[] = [];
let configValues: Record<string, any> = {};

// Lightweight mock for the vscode APIs used by notification logic
const mockVscode = {
    window: {
        showInformationMessage: (...args: any[]) => {
            windowCalls.push({ method: 'showInformationMessage', args });
            return Promise.resolve(undefined);
        },
        showWarningMessage: (...args: any[]) => {
            windowCalls.push({ method: 'showWarningMessage', args });
            return Promise.resolve(undefined);
        },
        showErrorMessage: (...args: any[]) => {
            windowCalls.push({ method: 'showErrorMessage', args });
            return Promise.resolve(undefined);
        },
        withProgress: (options: any, task: (progress: any) => Promise<void>) => {
            const progress = {
                report: (value: any) => {
                    windowCalls.push({ method: 'withProgress', args: [options, value.message] });
                }
            };
            return task(progress);
        },
    },
    workspace: {
        getConfiguration: (section: string) => ({
            get: (key: string, defaultValue?: any): any => {
                const fullKey = `${section}.${key}`;
                if (fullKey in configValues) {
                    return configValues[fullKey];
                }
                return defaultValue;
            }
        })
    },
    ProgressLocation: {
        Notification: 15
    }
};

function resetCalls(): void {
    windowCalls.length = 0;
    configValues = {};
}

/**
 * Mirrors showTimedNotification helper from extension.ts.
 */
function showTimedNotification(message: string, timeoutMs: number = 2000): void {
    mockVscode.window.withProgress(
        { location: mockVscode.ProgressLocation.Notification, cancellable: false },
        (progress: any) => {
            progress.report({ message });
            return new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
        }
    );
}

/**
 * Mirrors the notification logic from executeStatement() success path.
 * Now uses showTimedNotification for auto-dismiss.
 */
function showSingleQuerySuccessNotification(executionTimeMs: number, rowCount: number): void {
    const showNotifications = mockVscode.workspace.getConfiguration('exasol').get('showQueryNotifications', true);
    if (showNotifications) {
        showTimedNotification(`Query executed in ${formatDuration(executionTimeMs)} — ${rowCount} rows returned`);
    }
}

/**
 * Mirrors the notification logic from executeStatement() failure path.
 * Error notifications still persist (no auto-dismiss).
 */
async function showSingleQueryFailureNotification(errorMsg: string): Promise<void> {
    const showNotifications = mockVscode.workspace.getConfiguration('exasol').get('showQueryNotifications', true);
    if (showNotifications) {
        await mockVscode.window.showErrorMessage(`Query failed: ${errorMsg}`, 'Show Details');
    }
}

/**
 * Mirrors the notification logic from executeQueries() batch summary path.
 * Success uses showTimedNotification; partial failure uses showWarningMessage (persistent).
 */
function showBatchSummaryNotification(
    totalStatements: number,
    successCount: number,
    failCount: number,
    batchDurationMs: number
): void {
    const showNotifications = mockVscode.workspace.getConfiguration('exasol').get('showQueryNotifications', true);
    if (showNotifications) {
        const totalDuration = formatDuration(batchDurationMs);
        if (failCount === 0) {
            showTimedNotification(`${successCount}/${totalStatements} queries executed in ${totalDuration}`);
        } else {
            mockVscode.window.showWarningMessage(`${successCount}/${totalStatements} queries executed (${failCount} failed) in ${totalDuration}`);
        }
    }
}

suite('Query Execution Notifications', () => {

    setup(() => {
        resetCalls();
    });

    suite('single query success notification', () => {
        test('uses auto-dismiss withProgress notification', () => {
            showSingleQuerySuccessNotification(1234, 42);

            assert.strictEqual(windowCalls.length, 1);
            assert.strictEqual(windowCalls[0].method, 'withProgress');
            assert.strictEqual(windowCalls[0].args[1], 'Query executed in 1.2s — 42 rows returned');
        });

        test('shows milliseconds for sub-second queries', () => {
            showSingleQuerySuccessNotification(567, 10);

            assert.strictEqual(windowCalls[0].args[1], 'Query executed in 567ms — 10 rows returned');
        });

        test('handles zero rows', () => {
            showSingleQuerySuccessNotification(100, 0);

            assert.strictEqual(windowCalls[0].args[1], 'Query executed in 100ms — 0 rows returned');
        });

        test('withProgress uses Notification location', () => {
            showSingleQuerySuccessNotification(1000, 10);

            assert.strictEqual(windowCalls[0].args[0].location, mockVscode.ProgressLocation.Notification);
        });
    });

    suite('single query failure notification', () => {
        test('shows persistent error message with Show Details button', async () => {
            await showSingleQueryFailureNotification('[42000] syntax error');

            assert.strictEqual(windowCalls.length, 1);
            assert.strictEqual(windowCalls[0].method, 'showErrorMessage');
            assert.strictEqual(windowCalls[0].args[0], 'Query failed: [42000] syntax error');
            assert.strictEqual(windowCalls[0].args[1], 'Show Details');
        });
    });

    suite('batch summary notification', () => {
        test('uses auto-dismiss notification when all queries succeed', () => {
            showBatchSummaryNotification(5, 5, 0, 3400);

            assert.strictEqual(windowCalls.length, 1);
            assert.strictEqual(windowCalls[0].method, 'withProgress');
            assert.strictEqual(windowCalls[0].args[1], '5/5 queries executed in 3.4s');
        });

        test('shows persistent warning when some queries fail', () => {
            showBatchSummaryNotification(5, 4, 1, 3400);

            assert.strictEqual(windowCalls.length, 1);
            assert.strictEqual(windowCalls[0].method, 'showWarningMessage');
            assert.strictEqual(windowCalls[0].args[0], '4/5 queries executed (1 failed) in 3.4s');
        });

        test('shows persistent warning with multiple failures', () => {
            showBatchSummaryNotification(10, 7, 3, 12500);

            assert.strictEqual(windowCalls[0].method, 'showWarningMessage');
            assert.strictEqual(windowCalls[0].args[0], '7/10 queries executed (3 failed) in 12.5s');
        });
    });

    suite('notifications suppressed when setting is false', () => {
        test('single query success is suppressed', () => {
            configValues['exasol.showQueryNotifications'] = false;

            showSingleQuerySuccessNotification(1000, 10);

            assert.strictEqual(windowCalls.length, 0);
        });

        test('single query failure is suppressed', async () => {
            configValues['exasol.showQueryNotifications'] = false;

            await showSingleQueryFailureNotification('some error');

            assert.strictEqual(windowCalls.length, 0);
        });

        test('batch summary is suppressed', () => {
            configValues['exasol.showQueryNotifications'] = false;

            showBatchSummaryNotification(5, 5, 0, 3000);

            assert.strictEqual(windowCalls.length, 0);
        });
    });

    suite('setting defaults to true', () => {
        test('notifications show when setting is not configured', () => {
            // configValues is empty — no explicit setting
            showSingleQuerySuccessNotification(1000, 10);

            assert.strictEqual(windowCalls.length, 1, 'Should show notification when setting is unset (defaults to true)');
        });
    });
});
