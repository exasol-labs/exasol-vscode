import { QueryResult } from '../queryExecutor';
import { TabResult } from '../panels/tabManager';

export class TabResultCollector {
    private tabs: TabResult[] = [];

    addResult(result: QueryResult): void {
        const index = this.tabs.length + 1;
        this.tabs.push({ label: `Result ${index}`, result });
    }

    addError(message: string): void {
        const index = this.tabs.length + 1;
        this.tabs.push({ label: `Result ${index}`, error: message });
    }

    getTabs(): TabResult[] {
        return this.tabs;
    }

    hasResults(): boolean {
        return this.tabs.length > 0;
    }
}
