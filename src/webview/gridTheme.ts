/**
 * Builds a glide-data-grid theme from VS Code CSS custom properties.
 *
 * Resolves the active editor colours at call time so the grid tracks the user's theme. Kept
 * DOM-bound but free of React so any glide surface can derive a matching theme.
 */
import { type Theme } from '@glideapps/glide-data-grid';

export const cssVar = (name: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
};

export const buildGridTheme = (): Partial<Theme> => {
    const background = cssVar('--vscode-editor-background', '#1e1e1e');
    const foreground = cssVar('--vscode-foreground', '#cccccc');
    const border = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.35)');
    const selection = cssVar('--vscode-editor-selectionBackground', 'rgba(38,79,120,0.4)');
    const accent = cssVar('--vscode-focusBorder', '#007fd4');
    const headerBackground = cssVar('--vscode-sideBarSectionHeader-background', background);
    const fontFamily = cssVar('--vscode-editor-font-family', 'monospace');
    const fontSize = cssVar('--vscode-editor-font-size', '13px');
    const description = cssVar('--vscode-descriptionForeground', '#999999');

    return {
        accentColor: accent,
        accentFg: foreground,
        accentLight: selection,
        textDark: foreground,
        textMedium: foreground,
        textLight: description,
        textBubble: foreground,
        bgIconHeader: headerBackground,
        fgIconHeader: foreground,
        textHeader: foreground,
        textHeaderSelected: foreground,
        bgCell: background,
        bgCellMedium: background,
        bgHeader: headerBackground,
        bgHeaderHasFocus: headerBackground,
        bgHeaderHovered: cssVar('--vscode-list-hoverBackground', headerBackground),
        borderColor: border,
        horizontalBorderColor: border,
        drilldownBorder: border,
        baseFontStyle: fontSize,
        headerFontStyle: `600 ${fontSize}`,
        fontFamily,
        editorFontSize: fontSize,
    };
};
