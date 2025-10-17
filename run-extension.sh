#!/bin/bash

echo "🚀 Starting Exasol VSCode Extension..."
echo ""

# Check if in correct directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Not in exasol-vscode directory"
    echo "Please run: cd /Users/mikhail.zhadanov/exasol-vscode"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Compile
echo "🔨 Compiling TypeScript..."
npm run compile
echo ""

# Check if compilation succeeded
if [ $? -eq 0 ]; then
    echo "✅ Compilation successful!"
    echo ""
    echo "📂 Opening VS Code..."
    code .
    echo ""
    echo "🎯 Next step: Press F5 in VS Code to launch the extension"
    echo ""
    echo "📝 In the new window that opens:"
    echo "   1. Click the Exasol icon (blue E) in the left sidebar"
    echo "   2. Click + to add connection"
    echo "   3. Enter: localhost:8563, sys, exasol"
    echo "   4. Start querying!"
else
    echo "❌ Compilation failed. Check errors above."
    exit 1
fi
