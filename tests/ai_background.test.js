const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function worker(storage, sent, options = {}) {
    let listener, updated;
    const busSource = fs.readFileSync(require.resolve('../js/commons.js'), 'utf8');
    const callback = busSource.match(/runtime\.onMessage\.addListener\((.*?)\)\}async messageHandler/s)?.[1];
    assert.ok(callback);
    const legacy = Function('return ' + callback).call({
        messageHandler: async () => ({ error_type: true, error_message: 'isParcel ==> false' })
    });
    const context = {
        URL, Date: { now: () => options.now ?? Date.now() }, crypto: require('node:crypto').webcrypto, setTimeout: options.schedule || setTimeout,
        chrome: {
            storage: { session: {
                async get(keys) { const result = {}; for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = storage[key]; return result; },
                async set(value) { Object.assign(storage, value); },
                async remove(key) { delete storage[key]; }
            } },
            runtime: { onMessage: { addListener(fn) { listener = fn; } } },
            tabs: {
                async create() { return { id: 20, url: 'https://chatgpt.com/', status: options.createStatus || 'complete' }; },
                async get(id) { return { id, url: 'https://chatgpt.com/c/test', status: 'complete' }; },
                async update(...args) { options.updates?.push(args); },
                async sendMessage(...args) { sent.push(args); if (options.busyCount > 0) { options.busyCount--; return { busy: true }; } return options.noAcknowledgement ? undefined : { ok: true, id: args[1].job?.id }; },
                onUpdated: { addListener(fn) { updated = fn; } },
                onRemoved: { addListener() {} }
            }
        }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../js/ai_background.js'), 'utf8'), context);
    return {
        request: (message, sender) => new Promise(resolve => {
            const response = legacy(message, sender);
            if (response && typeof response.then === 'function') response.then(resolve);
            listener(message, sender, resolve);
        }),
        message: (message, sender) => listener(message, sender, () => {}),
        updated: id => updated(id, { status: 'complete' })
    };
}
const source = { url: 'https://courses.openedu.ru/test', tab: { id: 3 }, frameId: 7 };

test('MV3 restart keeps request identity and routes the response to its source frame', async () => {
    const storage = {}, sent = [];
    const first = worker(storage, sent);
    const response = await first.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'Solve this question' }, source);
    assert.ok(response.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1].type, 'PARAMEXT_CHATGPT_RUN');
    const restarted = worker(storage, sent);
    restarted.updated(20);
    await flush();
    assert.equal(sent.length, 1, 'an already dispatched prompt must not be sent twice after worker restart');
    restarted.message({ type: 'PARAMEXT_CHATGPT_RESULT', id: response.id, text: '{"answers":[]}' }, { url: 'https://chatgpt.com/c/test', tab: { id: 20 } });
    await flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[1][0], 3);
    assert.equal(sent[1][2].frameId, 7);
    assert.equal(sent[1][1].id, response.id);
    assert.equal(storage.paramExtAiJob, undefined);
});

test('concurrent frames cannot overwrite the active job; unrelated ChatGPT tabs cannot complete it', async () => {
    const storage = {}, sent = [];
    const w = worker(storage, sent);
    const response = await w.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'first' }, source);
    const busy = await w.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'second' }, { ...source, frameId: 9 });
    assert.equal(busy.busy, true);
    assert.equal(storage.paramExtAiJob.id, response.id);
    w.message({ type: 'PARAMEXT_CHATGPT_RESULT', id: response.id, text: 'fake' }, { url: 'https://chatgpt.com/', tab: { id: 21 } });
    await flush();
    assert.equal(storage.paramExtAiJob.id, response.id);
    assert.equal(sent.length, 1);
});


test('new tab is dispatched even if its load events fire before the job is saved', async () => {
    const storage = {}, sent = [];
    const w = worker(storage, sent, { createStatus: 'loading' });
    const response = await w.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'question' }, source);
    assert.ok(response.id);
    assert.equal(sent.filter(entry => entry[1].type === 'PARAMEXT_CHATGPT_RUN').length, 1);
});

test('an unacknowledged delivery is reported instead of silently marked dispatched', async () => {
    const storage = {}, sent = [];
    const w = worker(storage, sent, { noAcknowledgement: true });
    await w.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'question' }, source);
    assert.notEqual(storage.paramExtAiJob?.dispatched, true);
    assert.ok(sent.some(entry => entry[1].type === 'PARAMEXT_AI_RESULT' && /acknowledge/.test(entry[1].error)));
});


test('send failures notify OpenEdu without switching away from the failed ChatGPT composer', async () => {
    const storage = {}, sent = [], updates = [];
    const w = worker(storage, sent, { updates });
    const response = await w.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'question' }, source);
    updates.length = 0;
    w.message({ type: 'PARAMEXT_CHATGPT_RESULT', id: response.id, error: 'The editor did not retain the prompt' }, { url: 'https://chatgpt.com/', tab: { id: 20 } });
    await flush();
    assert.equal(updates.length, 0);
    assert.equal(sent.at(-1)[1].type, 'PARAMEXT_AI_RESULT');
    assert.match(sent.at(-1)[1].error, /editor/);
});

test('a slow eight-minute job remains reserved across worker restart and delivers its result', async () => {
    const storage = {}, sent = [];
    const first = worker(storage, sent, { now: 0 });
    const response = await first.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'first' }, source);
    const restarted = worker(storage, sent, { now: 8 * 60 * 1000 });
    const busy = await restarted.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'second' }, { ...source, frameId: 9 });
    assert.equal(busy.busy, true);
    assert.equal(storage.paramExtAiJob.id, response.id);
    restarted.message({ type: 'PARAMEXT_CHATGPT_RESULT', id: response.id, text: '{"answers":[]}' }, { url: 'https://chatgpt.com/', tab: { id: 20 } });
    await flush();
    assert.equal(sent.at(-1)[1].text, '{"answers":[]}');
    assert.equal(sent.at(-1)[2].frameId, 7);
    assert.equal(storage.paramExtAiJob, undefined);
});

test('configured timeout is forwarded to ChatGPT and preserved across worker restart', async () => {
    const storage = {}, sent = [];
    const first = worker(storage, sent, { now: 0 });
    const response = await first.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'slow', answerTimeoutMs: 25 * 60000 }, source);
    assert.equal(storage.paramExtAiJob.answerTimeoutMs, 25 * 60000);
    assert.equal(sent[0][1].job.answerTimeoutMs, 25 * 60000);
    const restarted = worker(storage, sent, { now: 20 * 60000 });
    const busy = await restarted.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'other', answerTimeoutMs: 60000 }, source);
    assert.equal(busy.busy, true);
    assert.equal(storage.paramExtAiJob.id, response.id);
    restarted.message({ type: 'PARAMEXT_CHATGPT_RESULT', id: response.id, text: 'late' }, { url: 'https://chatgpt.com/', tab: { id: 20 } });
    await flush();
    assert.equal(sent.at(-1)[1].text, 'late');
});

test('a correction prompt retries delivery when the previous tab job is still releasing', async () => {
    const storage = {}, sent = [], timers = [];
    const w = worker(storage, sent, { busyCount: 1, schedule: callback => timers.push(callback) });
    const response = await w.request({ type: 'PARAMEXT_AI_REQUEST', prompt: 'Fill missing answers' }, source);
    assert.equal(storage.paramExtAiJob.dispatched, undefined);
    assert.equal(timers.length, 1);
    timers.shift()(); await flush();
    assert.equal(storage.paramExtAiJob.dispatched, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[1][1].job.id, response.id);
});
