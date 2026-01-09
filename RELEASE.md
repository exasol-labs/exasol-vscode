# Release Checklist for Exasol VS Code Extension

Use this checklist when creating a new release.

## Pre-Release Steps

- [ ] Update version in `package.json` (e.g., `1.0.1` → `1.0.2`)
- [ ] Update `CHANGELOG.md` with new features, fixes, and changes
- [ ] Run tests: `npm run compile && npm test`
- [ ] Verify extension works in development mode: Press `F5`
- [ ] Test key features:
  - [ ] Add connection
  - [ ] Execute queries
  - [ ] Browse objects
  - [ ] IntelliSense works
  - [ ] Export results

## Build Package

```bash
# Make sure dependencies are up to date
npm install

# Package the extension
npx vsce package
```

This creates: `exasol-vscode-X.Y.Z.vsix`

**Verify package:**
```bash
# Check file size (should be ~1 MB)
ls -lh exasol-vscode-*.vsix

# Inspect contents (optional)
npx vsce ls --tree
```

## Test Package Locally

Before releasing, test the packaged extension:

```bash
# Uninstall current version (if any)
code --uninstall-extension exasol.exasol-vscode

# Install from package
code --install-extension exasol-vscode-X.Y.Z.vsix

# Reload VS Code and test
```

## Create GitHub Release

1. **Go to GitHub Releases:**
   - Navigate to: https://github.com/exasol/exasol-vscode/releases/new

2. **Fill in release details:**
   - Tag version: `vX.Y.Z` (e.g., `v1.0.1`)
   - Release title: `Exasol VS Code Extension vX.Y.Z`
   - Description: Copy relevant section from `CHANGELOG.md`

3. **Attach the .vsix file:**
   - Drag and drop `exasol-vscode-X.Y.Z.vsix` into the release assets

4. **Publish release** ✅

## Post-Release

- [ ] Test download link from release page
- [ ] Verify installation from downloaded .vsix works
- [ ] Announce release (if applicable)

## Important Notes

⚠️ **NEVER use `--no-dependencies` flag** when packaging! The extension requires:
- `@exasol/exasol-driver-ts`
- `ws`
- Other runtime dependencies

✅ Always use: `npx vsce package` (includes dependencies automatically)

## Versioning

Follow [Semantic Versioning](https://semver.org/):
- **Major** (2.0.0): Breaking changes
- **Minor** (1.1.0): New features, backwards compatible
- **Patch** (1.0.1): Bug fixes, backwards compatible
