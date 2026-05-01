/**
 * saved-search-export-client.js
 * Page-world saved search exporter with access to NetSuite N/search.
 */
(function () {
    'use strict';

    if (window.__tactaSavedSearchExportClientLoaded) return;
    window.__tactaSavedSearchExportClientLoaded = true;

    function emit(detail) {
        window.dispatchEvent(new CustomEvent('tacta:sse:allExportEvent', { detail: detail }));
    }

    function getValue(result, column) {
        var text = '';
        var value = '';
        try { text = result.getText(column); } catch (_) {}
        try { value = result.getValue(column); } catch (_) {}
        if (Array.isArray(text)) return text.join(', ');
        if (text !== null && text !== undefined && text !== '') return String(text);
        if (Array.isArray(value)) return value.join(', ');
        return value === null || value === undefined ? '' : String(value);
    }

    function getColumnLabel(column, index) {
        return column.label || column.name || ('Column ' + (index + 1));
    }

    function exportAllSavedSearch(requestId, searchId, pageSize) {
        if (!searchId) {
            emit({ requestId: requestId, type: 'error', message: 'No saved search ID was found in the page URL.' });
            return;
        }

        if (typeof require !== 'function') {
            emit({ requestId: requestId, type: 'error', message: 'NetSuite require() is not available on this page.' });
            return;
        }

        require(['N/search'], function (search) {
            try {
                var loadedSearch = search.load({ id: searchId });
                var columns = loadedSearch.columns || [];
                var headers = columns.map(getColumnLabel);
                var paged = loadedSearch.runPaged({ pageSize: pageSize || 1000 });
                var totalPages = paged.pageRanges.length;
                var totalRows = paged.count || 0;

                emit({
                    requestId: requestId,
                    type: 'start',
                    headers: headers,
                    totalRows: totalRows,
                    totalPages: totalPages
                });

                for (var p = 0; p < totalPages; p++) {
                    var pageRange = paged.pageRanges[p];
                    var page = paged.fetch({ index: pageRange.index });
                    var rows = [];

                    page.data.forEach(function (result) {
                        rows.push(columns.map(function (column) {
                            return getValue(result, column);
                        }));
                    });

                    emit({
                        requestId: requestId,
                        type: 'chunk',
                        page: p + 1,
                        totalPages: totalPages,
                        rows: rows
                    });

                    emit({
                        requestId: requestId,
                        type: 'progress',
                        page: p + 1,
                        totalPages: totalPages,
                        exportedRows: Math.min((p + 1) * (pageSize || 1000), totalRows),
                        totalRows: totalRows
                    });
                }

                emit({
                    requestId: requestId,
                    type: 'complete',
                    totalRows: totalRows,
                    totalPages: totalPages
                });
            } catch (e) {
                emit({ requestId: requestId, type: 'error', message: e && e.message ? e.message : String(e) });
            }
        }, function (err) {
            emit({
                requestId: requestId,
                type: 'error',
                message: 'Could not load N/search: ' + (err && err.message ? err.message : String(err))
            });
        });
    }

    window.addEventListener('tacta:sse:exportAllRequest', function (event) {
        var detail = event.detail || {};
        exportAllSavedSearch(detail.requestId, detail.searchId, detail.pageSize);
    });
})();
