import * as vscode from 'vscode';
import { QueryResult } from '../queryExecutor';
import { createWebviewRenderContext } from '../utils';

export interface QueryStats {
    query: string;
    executionTime: number;
    rowCount: number;
    columnCount: number;
    timestamp: Date;
}

export class QueryStatsPanel implements vscode.WebviewViewProvider {
    private static instance: QueryStatsPanel | undefined;
    private view: vscode.WebviewView | undefined;
    private currentStats: QueryStats | undefined;

    private constructor(private readonly extensionUri: vscode.Uri) {}

    public static register(context: vscode.ExtensionContext): QueryStatsPanel {
        const provider = new QueryStatsPanel(context.extensionUri);
        QueryStatsPanel.instance = provider;
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('exasol.queryStats', provider, {
                webviewOptions: { retainContextWhenHidden: true }
            })
        );
        return provider;
    }

    public static updateStats(query: string, result: QueryResult) {
        if (!QueryStatsPanel.instance) {
            return;
        }
        const stats: QueryStats = {
            query: query.trim(),
            executionTime: result.executionTime,
            rowCount: result.rowCount,
            columnCount: result.columns.length,
            timestamp: new Date()
        };
        QueryStatsPanel.instance.update(stats);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
        this.view = webviewView;
        this.view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };

        // Listen for messages from other panels
        this.view.webview.onDidReceiveMessage(message => {
            if (message.command === 'updateCellInspector') {
                this.updateCellInspector(message.column, message.value, message.type);
            }
        });

        this.updateWebview();
    }

    private updateCellInspector(column: string, value: any, type: string) {
        if (!this.view) {
            return;
        }

        this.view.webview.postMessage({
            command: 'showCellInspector',
            column,
            value,
            type
        });
    }

    public static updateCellInspector(column: string, value: any, type: string) {
        QueryStatsPanel.instance?.updateCellInspector(column, value, type);
    }

    private update(stats: QueryStats) {
        this.currentStats = stats;
        this.updateWebview();
    }

    private updateWebview() {
        if (!this.view) {
            return;
        }
        if (!this.currentStats) {
            this.view.webview.html = this.getEmptyHtml();
            return;
        }
        this.view.webview.html = this.getStatsHtml(this.currentStats);
    }

    private getEmptyHtml(): string {
        const ctx = createWebviewRenderContext(this.view!.webview, this.extensionUri, vscode.Uri.joinPath);
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${ctx.nonce}">
        body {
            padding: 12px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-sideBar-background);
            font-size: 12px;
        }
        .empty {
            text-align: center;
            padding: 20px;
            opacity: 0.6;
        }
    </style>
</head>
<body>
    <div class="empty">Execute a query to see statistics</div>
</body>
</html>`;
    }

    private getStatsHtml(stats: QueryStats): string {
        const ctx = createWebviewRenderContext(this.view!.webview, this.extensionUri, vscode.Uri.joinPath);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${ctx.mediaUri('query-stats.css')}">
</head>
<body>
    <div class="cell-inspector" id="cellInspector">
        <div class="section-header">Cell Value</div>
        <div class="inspector-header">
            <span class="inspector-column" id="inspectorColumn"></span>
            <span class="inspector-type" id="inspectorType"></span>
        </div>
        <div class="inspector-value" id="inspectorValue"></div>
    </div>

    <div class="section-header">Query Statistics</div>
    <div class="stat-group">
        <div class="stat-item">
            <span class="stat-label">Time</span>
            <span class="stat-value highlight" id="statTime"></span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Rows</span>
            <span class="stat-value success" id="statRows"></span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Cols</span>
            <span class="stat-value" id="statCols"></span>
        </div>
    </div>

    <div class="stat-group">
        <div class="stat-item">
            <span class="stat-label">Throughput</span>
            <span class="stat-value" id="statThroughput"></span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Avg/Row</span>
            <span class="stat-value" id="statAvgRow"></span>
        </div>
    </div>

    <div class="stat-group">
        <div class="stat-label query-label">Query</div>
        <div class="query-preview" id="queryPreview"></div>
    </div>

    <div class="timestamp" id="statTimestamp"></div>

    ${ctx.dataIsland('stats-data', {
        timeFormatted: this.formatTime(stats.executionTime),
        rowCount: stats.rowCount.toLocaleString(),
        columnCount: stats.columnCount,
        throughput: this.calculateThroughput(stats),
        avgRowTime: this.calculateAvgRowTime(stats),
        queryTitle: stats.query,
        queryPreview: this.getQueryPreview(stats.query),
        timestampFormatted: this.formatTimestamp(stats.timestamp)
    })}
    <script nonce="${ctx.nonce}" src="${ctx.mediaUri('query-stats.js')}"></script>
    <script nonce="${ctx.nonce}">
        (function () {
            const d = JSON.parse(document.getElementById('stats-data').textContent);
            document.getElementById('statTime').textContent = d.timeFormatted;
            document.getElementById('statRows').textContent = d.rowCount;
            document.getElementById('statCols').textContent = d.columnCount;
            document.getElementById('statThroughput').textContent = d.throughput;
            document.getElementById('statAvgRow').textContent = d.avgRowTime;
            const qp = document.getElementById('queryPreview');
            qp.textContent = d.queryPreview;
            qp.title = d.queryTitle;
            document.getElementById('statTimestamp').textContent = d.timestampFormatted;
        })();
    </script>
</body>
</html>`;
    }

    private getQueryPreview(query: string): string {
        const cleaned = query.replace(/\s+/g, ' ').trim();
        const maxLength = 50;
        if (cleaned.length <= maxLength) {
            return cleaned;
        }
        return cleaned.substring(0, maxLength) + '...';
    }

    private formatTime(ms: number): string {
        if (ms < 1000) {
            return `${ms}ms`;
        }
        const seconds = ms / 1000;
        if (seconds < 60) {
            return `${seconds.toFixed(2)}s`;
        }
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = (seconds % 60).toFixed(0);
        return `${minutes}m ${remainingSeconds}s`;
    }

    private formatTimestamp(date: Date): string {
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

    private calculateThroughput(stats: QueryStats): string {
        if (stats.executionTime === 0 || stats.rowCount === 0) {
            return 'N/A';
        }
        const rowsPerSecond = (stats.rowCount / stats.executionTime) * 1000;
        if (rowsPerSecond < 1) {
            return '< 1 row/s';
        }
        if (rowsPerSecond >= 1000) {
            return `${(rowsPerSecond / 1000).toFixed(1)}K row/s`;
        }
        return `${Math.round(rowsPerSecond)} row/s`;
    }

    private calculateAvgRowTime(stats: QueryStats): string {
        if (stats.rowCount === 0) {
            return 'N/A';
        }
        const msPerRow = stats.executionTime / stats.rowCount;
        if (msPerRow < 0.01) {
            return '< 0.01ms';
        }
        if (msPerRow < 1) {
            return `${msPerRow.toFixed(2)}ms`;
        }
        return `${msPerRow.toFixed(1)}ms`;
    }

}
