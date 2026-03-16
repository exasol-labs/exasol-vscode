import { QueryResult } from '../queryExecutor';

export interface TabResult {
    label: string;
    result?: QueryResult;
    error?: string;
}

export interface TabState {
    sortColumn: string | null;
    sortDirection: 'asc' | 'desc' | null;
    filterText: string;
    scrollPosition: number;
}

function defaultTabState(): TabState {
    return {
        sortColumn: null,
        sortDirection: null,
        filterText: '',
        scrollPosition: 0
    };
}

export class TabManager {
    private tabs: TabResult[] = [];
    private activeIndex: number = 0;
    private tabStates: TabState[] = [];

    setTabs(tabs: TabResult[]): void {
        this.tabs = [...tabs];
        this.activeIndex = 0;
        this.tabStates = tabs.map(() => defaultTabState());
    }

    getActiveTab(): TabResult | undefined {
        if (this.tabs.length === 0) {
            return undefined;
        }
        return this.tabs[this.activeIndex];
    }

    getActiveIndex(): number {
        return this.activeIndex;
    }

    switchTab(index: number): void {
        if (index < 0 || index >= this.tabs.length) {
            return;
        }
        this.activeIndex = index;
    }

    getTabs(): TabResult[] {
        return this.tabs;
    }

    shouldShowTabBar(): boolean {
        return this.tabs.length > 1;
    }

    clearTabs(): void {
        this.tabs = [];
        this.activeIndex = 0;
        this.tabStates = [];
    }

    getTabState(index: number): TabState {
        if (index < 0 || index >= this.tabStates.length) {
            return defaultTabState();
        }
        return this.tabStates[index];
    }

    updateTabState(index: number, state: Partial<TabState>): void {
        if (index < 0 || index >= this.tabStates.length) {
            return;
        }
        this.tabStates[index] = { ...this.tabStates[index], ...state };
    }
}
