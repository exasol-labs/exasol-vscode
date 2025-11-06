#!/bin/bash

echo "🧹 Cleaning up old Exasol extension..."

# Uninstall any existing Exasol extension
code --uninstall-extension exasol.exasol-vscode 2>/dev/null || true

echo "⏳ Waiting for VS Code to process uninstall..."
sleep 2

echo "📦 Installing new VSIX..."
code --install-extension exasol-vscode-0.1.1.vsix --force

echo "✅ Installation complete!"
echo ""
echo "📋 Next steps:"
echo "1. Close ALL VS Code windows"
echo "2. Reopen VS Code"
echo "3. Open a .sql file"
echo "4. Click the language indicator in the bottom-right corner"
echo "5. Select 'Exasol SQL' from the list"
echo ""
echo "If you still don't see 'Exasol SQL' in the language list:"
echo "- Press CMD+SHIFT+P"
echo "- Type 'Developer: Reload Window'"
echo "- Try again"
