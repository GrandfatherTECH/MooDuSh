/* Short messages + session storage survive MV3 worker suspension during generation. */
(function () {
    const KEY = 'paramExtAiJob';
    const TAB = 'paramExtAiTab';
    // Extra time covers tab loading, editor/send setup and result delivery.
    const answerTimeout = value => Math.min(3600000, Math.max(60000, Number(value) || 600000));
    const jobTimeout = job => answerTimeout(job.answerTimeoutMs) + 120000;
    let reserving = false;
    let dispatching = false;
    const isOpenedu = url => { try { return /(^|\.)openedu\.ru$/.test(new URL(url).hostname); } catch (_) { return false; } };
    const isChatgpt = url => { try { return new URL(url).origin === 'https://chatgpt.com'; } catch (_) { return false; } };
    async function finish(job, result) {
        await chrome.storage.session.remove(KEY);
        try {
            // Keep a failed composer visible so its status/draft can be inspected.
            if (!result.error) await chrome.tabs.update(job.sourceTab, { active: true });
            await chrome.tabs.sendMessage(job.sourceTab, { type: 'PARAMEXT_AI_RESULT', id: job.id, ...result }, { frameId: job.sourceFrame });
        } catch (_) { /* Source frame was closed or navigated. */ }
    }
    async function dispatch(job) {
        if (dispatching) return;
        dispatching = true;
        try {
            const current = (await chrome.storage.session.get(KEY))[KEY];
            if (!current || current.id !== job.id || current.dispatched) return;
            const tab = await chrome.tabs.get(job.aiTab);
            if (!isChatgpt(tab.url) || tab.status !== 'complete') return;
            const acknowledgement = await chrome.tabs.sendMessage(job.aiTab, { type: 'PARAMEXT_CHATGPT_RUN', job: { id: job.id, prompt: job.prompt, images: job.images, answerTimeoutMs: answerTimeout(job.answerTimeoutMs) } });
            if (acknowledgement?.busy) {
                // The previous result can reach OpenEdu before the tab adapter
                // clears activeJob. Retry the queued request once it releases.
                if (Date.now() - job.createdAt < jobTimeout(job)) setTimeout(() => dispatch(job), 500);
                else await finish(job, { error: 'ChatGPT adapter remained busy until the request timed out' });
                return;
            }
            if (acknowledgement?.ok !== true || acknowledgement.id !== job.id) {
                throw new Error('ChatGPT adapter did not acknowledge the prompt');
            }
            const latest = (await chrome.storage.session.get(KEY))[KEY];
            if (latest?.id === job.id) await chrome.storage.session.set({ [KEY]: { ...latest, dispatched: true } });
        } catch (error) {
            if (/Receiving end does not exist|Could not establish connection/.test(error.message)) {
                const current = (await chrome.storage.session.get(KEY))[KEY];
                if (current?.id === job.id) await chrome.storage.session.set({ [KEY]: { ...current, dispatched: false } });
                if (Date.now() - job.createdAt < 10000) setTimeout(() => dispatch(job), 500);
                else await finish(job, { error: 'ChatGPT adapter did not load. Reload the ChatGPT tab.' });
                return; // document_idle also signals readiness after injection.
            }
            await finish(job, { error: 'ChatGPT tab unavailable. Reload the extension and ChatGPT tab: ' + error.message });
        } finally { dispatching = false; }
    }
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type === 'PARAMEXT_AI_CAPTURE' && isOpenedu(sender.url) && sender.tab) {
            (async () => {
                const tab = await chrome.tabs.get(sender.tab.id);
                await chrome.tabs.update(tab.id, { active: true });
                await chrome.windows.update(tab.windowId, { focused: true });
                // Let scrolling, focus and lazy-loaded images settle before capture.
                await new Promise(resolve => setTimeout(resolve, 600));
                const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
                if (active?.id !== tab.id) throw new Error('Course tab lost focus during screenshot capture');
                return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
            })().then(respond).catch(error => respond({ error: error.message }));
            return true;
        }
        if (message?.type === 'PARAMEXT_AI_REQUEST' && isOpenedu(sender.url) && sender.tab) {
            (async () => {
                if (reserving) return { error: 'Another AI request is starting; try again shortly', busy: true };
                reserving = true;
                try {
                    const stored = await chrome.storage.session.get([KEY, TAB]);
                    if (stored[KEY] && Date.now() - stored[KEY].createdAt < jobTimeout(stored[KEY])) return { error: 'Another AI request is running', busy: true };
                    if (typeof message.prompt !== 'string' || message.prompt.length > 100000) throw new Error('Invalid AI prompt');
                    const images = message.images || [];
                    if (!Array.isArray(images) || images.length > 12 || images.some(image =>
                        !image || typeof image.name !== 'string' || !/^question-[A-Za-z0-9_-]+-\d+\.png$/.test(image.name)
                        || typeof image.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image.dataUrl))
                        || images.reduce((size, image) => size + image.dataUrl.length, 0) > 6000000) {
                        throw new Error('Invalid or oversized AI screenshots (maximum 12 images / 6 MB)');
                    }
                    let tab;
                    if (stored[TAB]) {
                        try { tab = await chrome.tabs.get(stored[TAB]); } catch (_) {}
                        if (tab && !isChatgpt(tab.url)) tab = null;
                    }
                    if (!tab) tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
                    else await chrome.tabs.update(tab.id, { active: true });
                    const job = { id: crypto.randomUUID(), sourceTab: sender.tab.id, sourceFrame: sender.frameId, aiTab: tab.id, createdAt: Date.now(), prompt: message.prompt, images, answerTimeoutMs: answerTimeout(message.answerTimeoutMs) };
                    await chrome.storage.session.set({ [KEY]: job, [TAB]: tab.id });
                    // Query current readiness after saving: create() can return a stale
                    // loading status after onUpdated/READY have already fired.
                    await dispatch(job);
                    return { id: job.id };
                } finally { reserving = false; }
            })().then(respond).catch(error => respond({ error: error.message }));
            return true;
        }
        if (message?.type === 'PARAMEXT_CHATGPT_READY' && isChatgpt(sender.url)) {
            (async () => {
                const stored = await chrome.storage.session.get([KEY, TAB]);
                const job = stored[KEY];
                if (job?.aiTab === sender.tab?.id) await dispatch(job);
                return { ok: true, managed: stored[TAB] === sender.tab?.id };
            })().then(respond).catch(error => respond({ error: error.message }));
            return true;
        }
        if (message?.type === 'PARAMEXT_CHATGPT_RESULT' && isChatgpt(sender.url)) {
            (async () => {
                const job = (await chrome.storage.session.get(KEY))[KEY];
                if (job && job.id === message.id && job.aiTab === sender.tab?.id) {
                    await finish(job, { text: message.text, error: message.error });
                }
            })().catch(() => {});
        }
    });
    chrome.tabs.onUpdated.addListener((id, change) => {
        if (change.status !== 'complete') return;
        chrome.storage.session.get(KEY).then(stored => {
            if (stored[KEY]?.aiTab === id && Date.now() - stored[KEY].createdAt < jobTimeout(stored[KEY])) dispatch(stored[KEY]);
        });
    });
    chrome.tabs.onRemoved.addListener(id => {
        chrome.storage.session.get(KEY).then(stored => {
            if (stored[KEY]?.aiTab === id) finish(stored[KEY], { error: 'ChatGPT tab was closed' });
        });
    });
})();
