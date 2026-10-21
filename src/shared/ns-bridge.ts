/**
 * ns-bridge.ts
 * NetSuite TactaSuite - Content Script <-> Page World Messaging Bridge
 *
 * @author Blane Maher
 */

export namespace TactaNSBridge {
    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    export const NAMESPACE = 'TACTA_NS_BRIDGE';
    const DIR_REQUEST = 'TACTA_REQUEST';
    const DIR_RESPONSE = 'TACTA_RESPONSE';
    const DEFAULT_TIMEOUT = 10000;

    // ────────────────────────────────────────────────────────────────
    // Types
    // ────────────────────────────────────────────────────────────────

    interface BridgeMessage {
        namespace: typeof NAMESPACE;
        direction: typeof DIR_REQUEST | typeof DIR_RESPONSE;
        messageId: string;
        action?: string;
        data?: any;
        success?: boolean;
        error?: string;
    }

    interface PendingRequest {
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        timer: number;
    }

    // ────────────────────────────────────────────────────────────────
    // Internal state
    // ────────────────────────────────────────────────────────────────

    let _msgIdCounter = 0;
    const _handlers: Record<string, (data: any) => any> = {};
    const _pending: Record<string, PendingRequest> = {};

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    function _generateId(): string {
        _msgIdCounter++;
        return `${NAMESPACE}_${_msgIdCounter}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    }

    function _isBridgeMessage(event: MessageEvent): event is MessageEvent<BridgeMessage> {
        return event.source === window
            && event.data
            && event.data.namespace === NAMESPACE;
    }

    // ────────────────────────────────────────────────────────────────
    // Message listener
    // ────────────────────────────────────────────────────────────────

    if (typeof window !== 'undefined') {
        window.addEventListener('message', (event) => {
            if (!_isBridgeMessage(event)) return;

            const msg = event.data;

            if (msg.direction === DIR_REQUEST && msg.action) {
                const handler = _handlers[msg.action];
                if (!handler) return;

                try {
                    const result = handler(msg.data);

                    if (result && typeof result.then === 'function') {
                        result.then((value: any) => {
                            window.postMessage({
                                namespace: NAMESPACE,
                                direction: DIR_RESPONSE,
                                messageId: msg.messageId,
                                success: true,
                                data: value
                            }, '*');
                        }).catch((err: any) => {
                            window.postMessage({
                                namespace: NAMESPACE,
                                direction: DIR_RESPONSE,
                                messageId: msg.messageId,
                                success: false,
                                error: err && err.message ? err.message : String(err)
                            }, '*');
                        });
                    } else {
                        window.postMessage({
                            namespace: NAMESPACE,
                            direction: DIR_RESPONSE,
                            messageId: msg.messageId,
                            success: true,
                            data: result
                        }, '*');
                    }
                } catch (err: any) {
                    window.postMessage({
                        namespace: NAMESPACE,
                        direction: DIR_RESPONSE,
                        messageId: msg.messageId,
                        success: false,
                        error: err && err.message ? err.message : String(err)
                    }, '*');
                }
                return;
            }

            if (msg.direction === DIR_RESPONSE) {
                const pending = _pending[msg.messageId];
                if (!pending) return;

                clearTimeout(pending.timer);
                delete _pending[msg.messageId];

                if (msg.success) {
                    pending.resolve(msg.data);
                } else {
                    pending.reject(new Error(msg.error || 'Bridge request failed'));
                }
            }
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────

    export function request<T = any>(action: string, data?: any, options?: { timeout?: number }): Promise<T> {
        const opts = options || {};
        const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
        const messageId = _generateId();

        return new Promise((resolve, reject) => {
            const timer = (setTimeout(() => {
                delete _pending[messageId];
                reject(new Error(`TactaNSBridge: Request timed out after ${timeout}ms for action "${action}"`));
            }, timeout) as unknown) as number;

            _pending[messageId] = { resolve, reject, timer };

            window.postMessage({
                namespace: NAMESPACE,
                direction: DIR_REQUEST,
                messageId: messageId,
                action: action,
                data: data !== undefined ? data : null
            }, '*');
        });
    }

    export function registerHandler(action: string, handler: (data: any) => any): void {
        if (typeof handler !== 'function') {
            throw new TypeError('TactaNSBridge.registerHandler: handler must be a function');
        }
        _handlers[action] = handler;
    }

    export function removeHandler(action: string): void {
        delete _handlers[action];
    }

    export function getRegisteredActions(): string[] {
        return Object.keys(_handlers);
    }

    export function hasHandler(action: string): boolean {
        return typeof _handlers[action] === 'function';
    }

    export function getPendingCount(): number {
        return Object.keys(_pending).length;
    }
}

// Global exposure
if (typeof window !== 'undefined') {
    (window as any).TactaNSBridge = TactaNSBridge;
}
