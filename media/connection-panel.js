(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // Read per-render config from the data island
    const connDataEl = document.getElementById('conn-data');
    const connData = connDataEl ? JSON.parse(connDataEl.textContent) : {};
    const isEdit = connData.isEdit === true;
    const submitLabel = isEdit ? 'Update' : 'Add';

    // Listen for messages from extension
    window.addEventListener('message', function (event) {
        const message = event.data;
        switch (message.command) {
            case 'error':
                showError(message.error);
                break;
            case 'testing':
                // Submit button is already disabled at submit time
                break;
        }
    });

    function toggleFingerprint() {
        const tlsMode = document.getElementById('tlsMode').value;
        document.getElementById('fingerprintGroup').style.display =
            tlsMode === 'fingerprint' ? 'block' : 'none';
    }

    document.getElementById('tlsMode').addEventListener('change', toggleFingerprint);

    document.getElementById('connectionForm').addEventListener('submit', function (e) {
        e.preventDefault();

        const name = document.getElementById('name').value.trim();
        const host = document.getElementById('host').value.trim();
        const port = document.getElementById('port').value.trim();
        const user = document.getElementById('user').value.trim();
        const password = document.getElementById('password').value;
        const tlsMode = document.getElementById('tlsMode').value;
        const fingerprint = document.getElementById('fingerprint').value.trim();

        // Validate required fields
        if (!name || !host || !port || !user || (!isEdit && !password)) {
            showError('All fields are required');
            return;
        }

        // Validate port is a valid number
        if (isNaN(port) || parseInt(port) <= 0 || parseInt(port) > 65535) {
            showError('Port must be a valid number between 1 and 65535');
            return;
        }

        // Validate fingerprint if provided
        if (tlsMode === 'fingerprint' && fingerprint) {
            const normalized = fingerprint.replace(/[:\s]/g, '').toUpperCase();
            if (!/^[0-9A-F]{64}$/.test(normalized)) {
                showError('Fingerprint must be a 64-character hexadecimal string (SHA-256)');
                return;
            }
        }

        // Hide any previous errors
        document.getElementById('errorMessage').style.display = 'none';

        // Disable submit button while testing
        const submitButton = document.getElementById('submitButton');
        submitButton.disabled = true;
        submitButton.textContent = 'Testing Connection...';

        // Send data to extension
        vscode.postMessage({
            command: 'submit',
            data: { name, host, port, user, password, tlsMode, fingerprint }
        });
    });

    document.getElementById('cancelButton').addEventListener('click', function () {
        vscode.postMessage({ command: 'cancel' });
    });

    function showError(message) {
        const errorDiv = document.getElementById('errorMessage');
        errorDiv.textContent = '❌ ' + message;
        errorDiv.style.display = 'block';

        // Re-enable submit button
        const submitButton = document.getElementById('submitButton');
        submitButton.disabled = false;
        submitButton.textContent = 'Test & ' + submitLabel + ' Connection';
    }

    // Focus on first input on load
    document.getElementById('name').focus();
}());
