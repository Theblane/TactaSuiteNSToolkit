/**
 * dom-utils.ts
 * TactaSuite NS Toolkit - DOM Manipulation Helpers
 *
 * @author Blane Maher
 *
 * Provides factory functions for creating themed UI components
 * (panels, modals, toasts, sidebars, tables) and general DOM utilities.
 */

export namespace TactaDOM {
    // ────────────────────────────────────────────────────────────────
    // Internal state
    // ────────────────────────────────────────────────────────────────

    let _idCounter = 0;
    let _shadowRoot: ShadowRoot | null = null;
    let _shadowWrapper: HTMLElement | null = null;

    function _uid(prefix?: string): string {
        return (prefix || 'tacta') + '-' + (++_idCounter) + '-' + Date.now().toString(36);
    }

    function _getToastContainer(): HTMLElement {
        const root = _ensureRoot();
        const existing = root.querySelector('.tacta-toast-container') as HTMLElement;
        if (existing) return existing;

        const container = document.createElement('div');
        container.className = 'tacta-toast-container';
        root.appendChild(container);
        return container;
    }

    function _ensureRoot(): HTMLElement {
        if (_shadowWrapper) return _shadowWrapper;

        let host = document.querySelector('#tacta-toolkit-host') as HTMLElement;
        if (!host) {
            host = document.createElement('div');
            host.id = 'tacta-toolkit-host';
            document.body.appendChild(host);
        }

        if (!host.shadowRoot) {
            _shadowRoot = host.attachShadow({ mode: 'open' });

            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                const styles = ['shared/theme-vars.css', 'shared/tactasuite-ui.css'];
                for (const stylePath of styles) {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = chrome.runtime.getURL(stylePath);
                    _shadowRoot.appendChild(link);
                }
            }

            _shadowWrapper = document.createElement('div');
            _shadowWrapper.className = 'tacta-toolkit';
            _shadowRoot.appendChild(_shadowWrapper);
        } else {
            _shadowRoot = host.shadowRoot;
            _shadowWrapper = _shadowRoot.querySelector('.tacta-toolkit') as HTMLElement;
            if (!_shadowWrapper) {
                _shadowWrapper = document.createElement('div');
                _shadowWrapper.className = 'tacta-toolkit';
                _shadowRoot.appendChild(_shadowWrapper);
            }
        }

        return _shadowWrapper;
    }

    const TOAST_ICONS: Record<string, string> = {
        success: '<svg class="tacta-toast-icon" viewBox="0 0 18 18" fill="none" stroke="#76c043" stroke-width="2"><circle cx="9" cy="9" r="8"/><path d="M5.5 9.5l2 2 5-5"/></svg>',
        error:   '<svg class="tacta-toast-icon" viewBox="0 0 18 18" fill="none" stroke="#e74c3c" stroke-width="2"><circle cx="9" cy="9" r="8"/><path d="M6 6l6 6M12 6l-6 6"/></svg>',
        warning: '<svg class="tacta-toast-icon" viewBox="0 0 18 18" fill="none" stroke="#f39c12" stroke-width="2"><path d="M9 2l8 14H1z"/><path d="M9 7v4M9 13v1"/></svg>',
        info:    '<svg class="tacta-toast-icon" viewBox="0 0 18 18" fill="none" stroke="#3498db" stroke-width="2"><circle cx="9" cy="9" r="8"/><path d="M9 8v5M9 5v1"/></svg>'
    };

    // ────────────────────────────────────────────────────────────────
    // createElement
    // ────────────────────────────────────────────────────────────────

    export interface CreateElementAttrs {
        className?: string;
        style?: Partial<CSSStyleDeclaration>;
        dataset?: Record<string, string>;
        events?: Record<string, EventListenerOrEventListenerObject>;
        innerHTML?: string;
        textContent?: string;
        [key: string]: any;
    }

    export function createElement<K extends keyof HTMLElementTagNameMap>(
        tag: K,
        attrs?: CreateElementAttrs,
        children?: (HTMLElement | string)[]
    ): HTMLElementTagNameMap[K] {
        const el = document.createElement(tag);

        if (attrs) {
            for (const [key, val] of Object.entries(attrs)) {
                if (key === 'className') {
                    el.className = val;
                } else if (key === 'style' && typeof val === 'object') {
                    Object.assign(el.style, val);
                } else if (key === 'dataset' && typeof val === 'object') {
                    for (const [dk, dv] of Object.entries(val)) {
                        el.dataset[dk] = dv as string;
                    }
                } else if (key === 'events' && typeof val === 'object') {
                    for (const [ek, ev] of Object.entries(val)) {
                        el.addEventListener(ek, ev as EventListenerOrEventListenerObject);
                    }
                } else if (key === 'innerHTML') {
                    el.innerHTML = val;
                } else if (key === 'textContent') {
                    el.textContent = val;
                } else {
                    el.setAttribute(key, String(val));
                }
            }
        }

        if (children) {
            for (const child of children) {
                if (typeof child === 'string') {
                    el.appendChild(document.createTextNode(child));
                } else {
                    el.appendChild(child);
                }
            }
        }

        return el;
    }

    // ────────────────────────────────────────────────────────────────
    // UI Helpers
    // ────────────────────────────────────────────────────────────────

    function _checkClickOutsideSetting(callback: (enabled: boolean) => void): void {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get('tacta_close_on_click_outside', (data) => {
                    callback(data.tacta_close_on_click_outside === true);
                });
            } else {
                callback(false);
            }
        } catch (_) {
            callback(false);
        }
    }

    function _makeDraggable(element: HTMLElement, handle: HTMLElement): void {
        let offsetX = 0;
        let offsetY = 0;
        let isDragging = false;

        const onMouseDown = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.tacta-panel-close') || target.closest('.tacta-btn')) return;
            isDragging = true;
            offsetX = e.clientX - element.getBoundingClientRect().left;
            offsetY = e.clientY - element.getBoundingClientRect().top;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            const x = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - element.offsetWidth));
            const y = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - element.offsetHeight));
            element.style.left = x + 'px';
            element.style.top = y + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
        };

        const onMouseUp = () => {
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        handle.addEventListener('mousedown', onMouseDown);
    }

    function _makeResizableBottomLeft(panel: HTMLElement, handle: HTMLElement): void {
        let isResizing = false;
        let startX: number, startY: number, startW: number, startH: number, startLeft: number;

        const onMove = (e: MouseEvent) => {
            if (!isResizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const newW = Math.max(280, startW - dx);
            const newH = Math.max(200, startH + dy);
            let newLeft = Math.max(0, startLeft + dx);

            if (newLeft + newW > startLeft + startW) {
                newLeft = startLeft + startW - newW;
            }

            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
            panel.style.left = newLeft + 'px';
            panel.style.right = 'auto';
        };

        const onUp = () => {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startW = rect.width;
            startH = rect.height;
            startLeft = rect.left;
            document.body.style.cursor = 'sw-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // ────────────────────────────────────────────────────────────────
    // createPanel
    // ────────────────────────────────────────────────────────────────

    export interface PanelOptions {
        title?: string;
        width?: string | number;
        height?: string | number;
        position?: {
            top?: string;
            right?: string;
            bottom?: string;
            left?: string;
        };
        resizable?: boolean;
        draggable?: boolean;
        onClose?: () => void;
        closeOnClickOutside?: boolean;
    }

    export function getToolkitRoot(): HTMLElement {
        return _ensureRoot();
    }

    export function createPanel(options: PanelOptions) {
        const opts = options || {};
        const id = _uid('panel');

        let width = typeof opts.width === 'number' ? opts.width + 'px' : opts.width || '360px';
        let height = typeof opts.height === 'number' ? opts.height + 'px' : opts.height || 'auto';

        const pos = opts.position || {};
        const resizable = opts.resizable !== false;
        const draggable = opts.draggable !== false;

        const panel = createElement('div', {
            id: id,
            className: 'tacta-panel' + (resizable ? ' tacta-panel--resizable' : ''),
            style: {
                width: width,
                height: height,
                top: pos.top || '60px',
                right: pos.right || (pos.left ? 'auto' : '16px'),
                bottom: pos.bottom || 'auto',
                left: pos.left || 'auto'
            }
        });

        const titleEl = createElement('div', { className: 'tacta-panel-title' }, [
            createElement('span', { className: 'tacta-accent-dot' }),
            createElement('span', { textContent: opts.title || 'Panel' })
        ]);

        const closeBtn = createElement('button', {
            className: 'tacta-panel-close',
            title: 'Close',
            innerHTML: '&#10005;'
        });

        const header = createElement('div', { className: 'tacta-panel-header' }, [
            titleEl,
            createElement('div', { className: 'tacta-panel-actions' }, [closeBtn])
        ]);

        const body = createElement('div', { className: 'tacta-panel-body' });

        panel.appendChild(header);
        panel.appendChild(body);

        if (resizable) {
            const resizeHandle = createElement('div', { className: 'tacta-panel-resize-handle' });
            panel.appendChild(resizeHandle);
            _makeResizableBottomLeft(panel, resizeHandle);
        }

        const close = () => {
            if (panel.parentNode) panel.parentNode.removeChild(panel);
            if (typeof opts.onClose === 'function') opts.onClose();
        };

        closeBtn.addEventListener('click', close);

        if (opts.closeOnClickOutside !== false) {
            _checkClickOutsideSetting((enabled) => {
                if (enabled) {
                    setTimeout(() => {
                        const onClickOutside = (e: MouseEvent) => {
                            if (!panel.parentNode) {
                                document.removeEventListener('mousedown', onClickOutside, true);
                                return;
                            }
                            const path = e.composedPath();
                            if (path.indexOf(panel) === -1) {
                                document.removeEventListener('mousedown', onClickOutside, true);
                                close();
                            }
                        };
                        document.addEventListener('mousedown', onClickOutside, true);
                    }, 200);
                }
            });
        }

        if (draggable) _makeDraggable(panel, header);

        _ensureRoot().appendChild(panel);

        return { panel, header, body, close };
    }

    export interface ModalOptions {
        title?: string;
        content?: string | HTMLElement;
        buttons?: { label: string; className?: string; onClick?: () => void }[];
        onClose?: () => void;
        closeOnOverlay?: boolean;
    }

    export function createModal(options: ModalOptions) {
        const opts = options || {};
        const overlay = createElement('div', { className: 'tacta-modal-overlay' });
        const modal = createElement('div', { className: 'tacta-modal' });

        const closeBtn = createElement('button', {
            className: 'tacta-panel-close',
            title: 'Close',
            innerHTML: '&#10005;'
        });

        const modalHeader = createElement('div', { className: 'tacta-modal-header' }, [
            createElement('div', { className: 'tacta-modal-title', textContent: opts.title || '' }),
            closeBtn
        ]);

        const modalBody = createElement('div', { className: 'tacta-modal-body' });
        if (typeof opts.content === 'string') {
            modalBody.innerHTML = opts.content;
        } else if (opts.content instanceof HTMLElement) {
            modalBody.appendChild(opts.content);
        }

        modal.appendChild(modalHeader);
        modal.appendChild(modalBody);

        if (opts.buttons) {
            const footer = createElement('div', { className: 'tacta-modal-footer' });
            for (const b of opts.buttons) {
                const btn = createElement('button', {
                    className: 'tacta-btn ' + (b.className || ''),
                    textContent: b.label
                });
                if (b.onClick) btn.addEventListener('click', b.onClick);
                footer.appendChild(btn);
            }
            modal.appendChild(footer);
        }

        overlay.appendChild(modal);

        const close = () => {
            overlay.classList.remove('tacta-visible');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            if (opts.onClose) opts.onClose();
        };

        closeBtn.addEventListener('click', close);
        if (opts.closeOnOverlay !== false) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close();
            });
        }

        _ensureRoot().appendChild(overlay);
        void (overlay as HTMLElement).offsetHeight;
        overlay.classList.add('tacta-visible');

        return { overlay, modal, body: modalBody, close };
    }

    export interface SidebarOptions {
        title?: string;
        content?: string | HTMLElement;
        width?: string | number;
        top?: string;
        overlay?: boolean;
        onClose?: () => void;
    }

    export function createSidebar(options: SidebarOptions) {
        const opts = options || {};
        const width = typeof opts.width === 'number' ? opts.width + 'px' : opts.width || '380px';

        const root = _ensureRoot();
        let overlayEl: HTMLElement | null = null;
        if (opts.overlay !== false) {
            overlayEl = createElement('div', { className: 'tacta-sidebar-overlay' });
            root.appendChild(overlayEl);
        }

        const closeBtn = createElement('button', {
            className: 'tacta-panel-close',
            title: 'Close',
            innerHTML: '&#10005;'
        });

        const sidebarHeader = createElement('div', { className: 'tacta-sidebar-header' }, [
            createElement('div', { className: 'tacta-sidebar-title', textContent: opts.title || '' }),
            closeBtn
        ]);

        const sidebarBody = createElement('div', { className: 'tacta-sidebar-body' });
        if (typeof opts.content === 'string') {
            sidebarBody.innerHTML = opts.content;
        } else if (opts.content instanceof HTMLElement) {
            sidebarBody.appendChild(opts.content);
        }

        const sidebar = createElement('div', {
            className: 'tacta-sidebar',
            style: {
                width,
                top: opts.top || '0',
                bottom: '0'
            }
        }, [sidebarHeader, sidebarBody]);

        root.appendChild(sidebar);

        const close = () => {
            sidebar.classList.remove('tacta-visible');
            if (overlayEl) overlayEl.classList.remove('tacta-visible');
            setTimeout(() => {
                if (sidebar.parentNode) sidebar.parentNode.removeChild(sidebar);
                if (overlayEl?.parentNode) overlayEl.parentNode.removeChild(overlayEl);
            }, 350);
            if (typeof opts.onClose === 'function') opts.onClose();
        };

        closeBtn.addEventListener('click', close);
        if (overlayEl) overlayEl.addEventListener('click', close);

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', onKeyDown);
            }
        };
        document.addEventListener('keydown', onKeyDown);

        requestAnimationFrame(() => {
            sidebar.classList.add('tacta-visible');
            if (overlayEl) overlayEl.classList.add('tacta-visible');
        });

        return { sidebar, body: sidebarBody, close };
    }

    export interface TableOptions {
        sortable?: boolean;
        searchable?: boolean;
        exportable?: boolean;
    }

    export function createTable(headers: string[], rows: Array<Array<string | number>>, options?: TableOptions) {
        const opts = options || {};
        let sortCol = -1;
        let sortAsc = true;
        let currentRows = rows.slice();

        const wrapper = createElement('div', { style: { width: '100%' } });
        let searchInput: HTMLInputElement | null = null;

        if (opts.searchable || opts.exportable) {
            const toolbar = createElement('div', {
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '8px'
                }
            });

            if (opts.searchable) {
                searchInput = createElement('input', {
                    className: 'tacta-input',
                    placeholder: 'Filter rows...',
                    style: { flex: '1' }
                }) as HTMLInputElement;
                searchInput.addEventListener('input', () => renderBody());
                toolbar.appendChild(searchInput);
            }

            if (opts.exportable) {
                const exportBtn = createElement('button', {
                    className: 'tacta-btn tacta-btn-sm',
                    textContent: 'Copy CSV'
                });
                exportBtn.addEventListener('click', () => {
                    let csv = headers.join(',') + '\n';
                    for (const row of currentRows) {
                        csv += row.map((cell) => {
                            const str = String(cell);
                            return str.indexOf(',') >= 0 || str.indexOf('"') >= 0
                                ? '"' + str.replace(/"/g, '""') + '"'
                                : str;
                        }).join(',') + '\n';
                    }
                    copyToClipboard(csv).then((ok) => {
                        if (ok) showToast('CSV copied to clipboard', 'success', 2000);
                    });
                });
                toolbar.appendChild(exportBtn);
            }

            wrapper.appendChild(toolbar);
        }

        const tableWrapper = createElement('div', { className: 'tacta-table-wrapper' });
        const table = createElement('table', { className: 'tacta-table' });
        const thead = createElement('thead');
        const headRow = createElement('tr');

        headers.forEach((header, h) => {
            const th = createElement('th', {
                textContent: header,
                className: opts.sortable ? 'tacta-sortable' : '',
                dataset: { col: String(h) }
            });
            if (opts.sortable) {
                th.addEventListener('click', () => {
                    if (sortCol === h) sortAsc = !sortAsc;
                    else {
                        sortCol = h;
                        sortAsc = true;
                    }
                    renderBody();
                    updateSortIndicators();
                });
            }
            headRow.appendChild(th);
        });

        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = createElement('tbody');
        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        wrapper.appendChild(tableWrapper);

        function updateSortIndicators(): void {
            const ths = headRow.querySelectorAll('th');
            ths.forEach((th) => {
                th.classList.remove('tacta-sort-asc', 'tacta-sort-desc');
                if (parseInt(th.dataset.col || '-1', 10) === sortCol) {
                    th.classList.add(sortAsc ? 'tacta-sort-asc' : 'tacta-sort-desc');
                }
            });
        }

        function renderBody(): void {
            let filtered = currentRows;
            if (searchInput && searchInput.value.trim()) {
                const term = searchInput.value.trim().toLowerCase();
                filtered = currentRows.filter((row) => row.some((cell) => String(cell).toLowerCase().indexOf(term) >= 0));
            }

            if (sortCol >= 0) {
                filtered = filtered.slice().sort((a, b) => {
                    let va: string | number = a[sortCol];
                    let vb: string | number = b[sortCol];
                    if (typeof va === 'number' && typeof vb === 'number') {
                        return sortAsc ? va - vb : vb - va;
                    }
                    va = String(va).toLowerCase();
                    vb = String(vb).toLowerCase();
                    if (va < vb) return sortAsc ? -1 : 1;
                    if (va > vb) return sortAsc ? 1 : -1;
                    return 0;
                });
            }

            tbody.innerHTML = '';
            for (const row of filtered) {
                const tr = createElement('tr');
                for (let c = 0; c < headers.length; c++) {
                    const cellVal = row[c] !== undefined ? row[c] : '';
                    tr.appendChild(createElement('td', { textContent: String(cellVal) }));
                }
                tbody.appendChild(tr);
            }
        }

        function refresh(newRows: Array<Array<string | number>>): void {
            currentRows = newRows.slice();
            sortCol = -1;
            sortAsc = true;
            updateSortIndicators();
            renderBody();
        }

        renderBody();

        return { wrapper, table, refresh };
    }

    export function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 4000) {
        const container = _getToastContainer();
        const icon = TOAST_ICONS[type] || TOAST_ICONS.info;

        const closeBtn = createElement('button', {
            className: 'tacta-toast-close',
            innerHTML: '&#10005;',
            title: 'Dismiss'
        });

        const toast = createElement('div', {
            className: 'tacta-toast tacta-toast--' + type
        }, [
            createElement('span', { innerHTML: icon }),
            createElement('span', { className: 'tacta-toast-message', textContent: message }),
            closeBtn
        ]);

        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('tacta-visible'));

        const dismiss = () => {
            toast.classList.remove('tacta-visible');
            toast.classList.add('tacta-toast-exit');
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 350);
        };

        closeBtn.addEventListener('click', dismiss);
        if (duration > 0) setTimeout(dismiss, duration);

        return { element: toast, dismiss };
    }

    export function injectStylesheet(url: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const wrapper = _ensureRoot();
            const shadow = wrapper.parentNode as ShadowRoot;

            if (shadow.querySelector(`link[href="${url}"]`)) {
                return resolve();
            }

            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = url;
            link.onload = () => resolve();
            link.onerror = () => reject(new Error(`Failed to load stylesheet: ${url}`));

            shadow.insertBefore(link, wrapper);
        });
    }

    export async function copyToClipboard(text: string): Promise<boolean> {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {
                return _fallbackCopy(text);
            }
        }
        return _fallbackCopy(text);
    }

    function _fallbackCopy(text: string): boolean {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    }
}

if (typeof window !== 'undefined') {
    (window as any).TactaDOM = TactaDOM;
}
