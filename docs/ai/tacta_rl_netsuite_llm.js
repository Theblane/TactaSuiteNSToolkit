/**
 * NetSuite TactaSuite - NetSuite AI (N/llm) RESTlet
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 * @author Blane Maher
 *
 * Thin JSON wrapper around N/llm.generateText so the TactaSuite Chrome
 * extension can use the NetSuite AI allotment of the account the user is
 * logged in to. The extension calls this RESTlet same-origin from the
 * NetSuite tab, so the normal session cookie and the user's role apply.
 *
 * GET  ?ping=true                 -> { ok: true, remainingFreeUsage, time }
 * POST { prompt, preamble, chatHistory, maxTokens, temperature, modelFamily }
 *                                 -> { text, model, usage: { remainingFreeUsage } }
 *
 * chatHistory items: { role: 'user' | 'chatbot', text: string }
 * Errors are always returned as JSON: { error: { name, message } }
 *
 * This script never writes to any record. It only forwards text to N/llm.
 */
define(['N/llm', 'N/log', 'N/runtime'], (llm, log, runtime) => {

    const MAX_PROMPT_CHARS = 100000;
    const MAX_PREAMBLE_CHARS = 20000;
    const MAX_HISTORY_ITEMS = 40;
    const DEFAULT_MAX_TOKENS = 2000;
    const MAX_MAX_TOKENS = 4000;

    /**
     * Builds the standard error envelope.
     * @param {Error|string} err
     * @returns {{ error: { name: string, message: string } }}
     */
    const errorJson = (err) => {
        const e = err || {};
        return {
            error: {
                name: String(e.name || 'ERROR'),
                message: String(e.message || e || 'Unknown error')
            }
        };
    };

    /**
     * Remaining free N/llm requests for this account this month, or null
     * when the API is not available in this account version.
     * @returns {number|null}
     */
    const remainingFreeUsage = () => {
        try {
            if (typeof llm.getRemainingFreeUsage === 'function') {
                return llm.getRemainingFreeUsage();
            }
        } catch (e) {
            log.debug('getRemainingFreeUsage failed', e.message);
        }
        return null;
    };

    /**
     * Converts the extension's chat history into N/llm ChatMessage objects.
     * @param {Array<{role: string, text: string}>} history
     * @returns {Array} llm.ChatMessage[]
     */
    const buildChatHistory = (history) => {
        if (!Array.isArray(history)) return [];
        const trimmed = history.slice(-MAX_HISTORY_ITEMS);
        const out = [];
        trimmed.forEach((item) => {
            if (!item || typeof item.text !== 'string' || !item.text.trim()) return;
            const role = String(item.role || '').toLowerCase() === 'chatbot'
                ? llm.ChatRole.CHATBOT
                : llm.ChatRole.USER;
            out.push(llm.createChatMessage({ role: role, text: item.text }));
        });
        return out;
    };

    /**
     * Resolves an optional model family name against llm.ModelFamily.
     * Unknown or missing values fall back to the NetSuite default.
     * @param {string} name
     * @returns {string|undefined}
     */
    const resolveModelFamily = (name) => {
        if (!name || !llm.ModelFamily) return undefined;
        const key = String(name).toUpperCase();
        return llm.ModelFamily[key] || undefined;
    };

    /**
     * GET handler. Used by the extension's "Test" button.
     * @param {Object} params - Query string parameters.
     * @returns {Object}
     */
    const get = (params) => {
        try {
            const user = runtime.getCurrentUser();
            return {
                ok: true,
                ping: !!(params && params.ping),
                user: user ? user.id : null,
                role: user ? user.role : null,
                remainingFreeUsage: remainingFreeUsage(),
                time: new Date().toISOString()
            };
        } catch (e) {
            log.error('tacta_rl_netsuite_llm GET failed', e);
            return errorJson(e);
        }
    };

    /**
     * POST handler. Runs one N/llm.generateText call.
     * @param {Object} body - Parsed JSON request body.
     * @returns {Object}
     */
    const post = (body) => {
        try {
            const req = body || {};
            if (typeof req.prompt !== 'string' || !req.prompt.trim()) {
                return errorJson({ name: 'MISSING_PROMPT', message: 'Request body must include a non-empty "prompt" string.' });
            }

            const prompt = req.prompt.length > MAX_PROMPT_CHARS
                ? req.prompt.slice(0, MAX_PROMPT_CHARS)
                : req.prompt;

            let preamble = typeof req.preamble === 'string' ? req.preamble : '';
            if (preamble.length > MAX_PREAMBLE_CHARS) preamble = preamble.slice(0, MAX_PREAMBLE_CHARS);

            let maxTokens = parseInt(req.maxTokens, 10);
            if (!maxTokens || maxTokens < 1) maxTokens = DEFAULT_MAX_TOKENS;
            if (maxTokens > MAX_MAX_TOKENS) maxTokens = MAX_MAX_TOKENS;

            let temperature = parseFloat(req.temperature);
            if (isNaN(temperature) || temperature < 0 || temperature > 1) temperature = 0.2;

            const options = {
                prompt: prompt,
                chatHistory: buildChatHistory(req.chatHistory),
                modelParameters: {
                    maxTokens: maxTokens,
                    temperature: temperature
                }
            };
            if (preamble) options.preamble = preamble;

            const family = resolveModelFamily(req.modelFamily);
            if (family) options.modelFamily = family;

            const started = Date.now();
            const response = llm.generateText(options);

            return {
                text: response && typeof response.text === 'string' ? response.text : '',
                model: response && response.model ? String(response.model) : null,
                usage: {
                    remainingFreeUsage: remainingFreeUsage(),
                    elapsedMs: Date.now() - started
                }
            };
        } catch (e) {
            log.error('tacta_rl_netsuite_llm POST failed', e);
            return errorJson(e);
        }
    };

    return { get: get, post: post };
});
