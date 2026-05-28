import { QueryResult } from '../queryExecutor';
import { TabResult } from '../panels/tabManager';

export class TabResultCollector {
    private tabs: TabResult[] = [];

    addResult(result: QueryResult): void {
        this.tabs.push({ label: `Result ${this.tabs.length + 1}`, result });
    }

    addError(message: string): void {
        this.tabs.push({ label: `Result ${this.tabs.length + 1}`, error: message });
    }

    getTabs(): TabResult[] {
        return this.tabs;
    }

    hasResults(): boolean {
        return this.tabs.length > 0;
    }
}
