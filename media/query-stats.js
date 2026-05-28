// query-stats.js: cell-inspector postMessage handler for the Query Statistics panel.
// Stats display values are injected via a JSON data island to avoid unsafe-inline JS.

(function () {
    'use strict';

    const cellInspector = document.getElementById('cellInspector');
    const inspectorColumn = document.getElementById('inspectorColumn');
    const inspectorType = document.getElementById('inspectorType');
    const inspectorValue = document.getElementById('inspectorValue');

    window.addEventListener('message', function (event) {
        const message = event.data;
        if (message.command === 'showCellInspector') {
            cellInspector.classList.add('visible');
            inspectorColumn.textContent = message.column;
            inspectorType.textContent = message.type;

            if (message.value === null || message.value === undefined || message.value === '') {
                inspectorValue.innerHTML = '<span class="inspector-null">(null)</span>';
            } else {
                inspectorValue.textContent = String(message.value);
            }
        }
    });
})();
