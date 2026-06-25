/**
 * Ambient type for raw CSS imports.
 *
 * esbuild's `text` loader turns a `.css` import into its stylesheet source as a string, which the
 * notebook renderer injects into a <style> element. This declaration lets TypeScript type that
 * default import as a string.
 */
declare module '*.css' {
    const content: string;
    export default content;
}
