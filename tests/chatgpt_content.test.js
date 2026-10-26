const { test } = require('node:test');
const assert = require('node:assert/strict');

const { chat } = require('./helpers/chatgpt_tab');

test('actual tab adapter enters and sends a prompt using the current composer button ID', async () => {
    const c = chat();
    try {
        const ack = c.deliver();
        assert.equal(ack.ok, true); assert.equal(ack.id, 'job');
        await c.advance(6000);
        assert.equal(c.sends, 1);
        assert.ok(c.inserted[0].includes('Solve these questions\nRequest ID: job'));
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
        assert.match(c.w.document.getElementById('moodush-chatgpt-status').textContent, /ответ получен/);
    } finally { c.dom.window.close(); }
});

test('tab adapter waits for a delayed editor and does not duplicate redelivered jobs', async () => {
    const c = chat({ late: true });
    try {
        c.deliver(); c.deliver();
        await c.advance(2000);
        assert.equal(c.sends, 0);
        c.mount(); await c.advance(6000);
        assert.equal(c.sends, 1);
        c.deliver(); await c.advance(1000);
        assert.equal(c.sends, 1);
    } finally { c.dom.window.close(); }
});

test('contenteditable composer works without execCommand and with a role-based editor', async () => {
    const c = chat({ contenteditable: true, alternateEditor: true });
    try {
        c.deliver(); await c.advance(6000);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('unsent user draft is preserved and the failure is visible', async () => {
    const c = chat({ draft: 'my draft' });
    try {
        c.deliver(); await c.advance(100);
        assert.equal(c.sends, 0);
        assert.equal(c.w.document.getElementById('prompt-textarea').value, 'my draft');
        assert.match(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.error, /unsent message/);
        assert.match(c.w.document.getElementById('moodush-chatgpt-status').textContent, /unsent message/);
    } finally { c.dom.window.close(); }
});

test('missing editor returns an explicit error after 30 seconds instead of waiting silently', async () => {
    const c = chat({ late: true });
    try {
        c.deliver(); await c.advance(31000);
        assert.equal(c.sends, 0);
        assert.match(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.error, /editor is unavailable/);
    } finally { c.dom.window.close(); }
});

test('hidden stale send controls cannot intercept the actual composer button', async () => {
    const c = chat({ hiddenDecoy: true });
    try {
        c.deliver(); await c.advance(6500);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('native form submission is supported and confirmed through the sent user message', async () => {
    const c = chat({ formSubmit: true });
    try {
        c.deliver(); await c.advance(6500);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('Enter fallback handles composers whose button click does not submit', async () => {
    const c = chat({ enterOnly: true });
    try {
        c.deliver(); await c.advance(10000);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('an ignored send action is reported rather than claiming the prompt was sent', async () => {
    const c = chat({ noAcceptance: true });
    try {
        c.deliver(); await c.advance(11000);
        assert.equal(c.sends, 0);
        assert.match(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.error, /did not confirm sending/);
        assert.ok(c.w.document.getElementById('prompt-textarea').value.includes('Request ID: job'));
    } finally { c.dom.window.close(); }
});


test('paragraph markup for pasted newlines does not falsely reject a correct prompt', async () => {
    const c = chat({ contenteditable: true, paragraphEdits: true });
    try {
        c.deliver('job', 'First line\nSecond line\nThird line');
        await c.advance(6500);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});


test('a matching generated draft left by a failed run resumes with a fresh request ID', async () => {
    const c = chat({ draft: 'Solve these questions\nRequest ID: old-job' });
    try {
        c.deliver('new-job'); await c.advance(6500);
        assert.equal(c.sends, 1);
        assert.ok(c.inserted[0].includes('Request ID: new-job'));
        assert.ok(!c.inserted[0].includes('old-job'));
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('a request marker alone cannot authorize replacing an unrelated draft', async () => {
    const draft = 'My unrelated question\nRequest ID: old-job';
    const c = chat({ draft });
    try {
        c.deliver(); await c.advance(100);
        assert.equal(c.sends, 0);
        assert.equal(c.w.document.getElementById('prompt-textarea').value, draft);
        assert.match(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.error, /unrelated unsent message/);
    } finally { c.dom.window.close(); }
});


test('collapsed sent prompts confirm acceptance even when their request marker is hidden', async () => {
    const c = chat({ collapsedPrompt: true });
    try {
        c.deliver(); await c.advance(6500);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('turn attributes support confirmation and reading responses without author-role attributes', async () => {
    const c = chat({ turnAttributes: true, collapsedPrompt: true });
    try {
        c.deliver(); await c.advance(6500);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('old assistant responses are excluded when matching a newly sent request', async () => {
    const c = chat({ collapsedPrompt: true });
    try {
        const old = c.w.document.createElement('article');
        old.dataset.turn = 'assistant'; old.dataset.turnId = 'old';
        old.innerHTML = '<div class="markdown">{"answers":["stale"]}</div><button data-testid="copy-turn-action-button"></button>';
        c.w.document.body.appendChild(old);
        c.deliver(); await c.advance(6500);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});


test('saved Work markup confirms an accepted prompt and reports cancellation precisely', async () => {
    const c = chat({ workLayout: 'cancelled' });
    try {
        c.deliver(); await c.advance(12000);
        assert.equal(c.sends, 1);
        const result = c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT');
        assert.match(result?.error, /accepted the prompt, but generation was cancelled/);
        assert.ok(!result.error.includes('did not confirm'));
    } finally { c.dom.window.close(); }
});

test('Work user and assistant share a turn key without hiding a completed answer', async () => {
    const c = chat({ workLayout: 'completed' });
    try {
        c.deliver(); await c.advance(6500);
        assert.equal(c.sends, 1);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});


test('Work accessibility heading is excluded from a plain JSON response', async () => {
    const c = chat({ workLayout: 'completed', workHeading: true });
    try {
        c.deliver(); await c.advance(6500);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('Work final response can be a sibling of the heading and activity block', async () => {
    const c = chat({ workLayout: 'completed', workHeading: true, workSibling: true });
    try {
        c.deliver(); await c.advance(6500);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('label-only response never parses the JSON example in the user prompt', async () => {
    const c = chat({ workLayout: 'completed', workHeading: true, workLabelOnly: true });
    try {
        c.deliver('job', 'Example {"answers":[{"questionKey":"example"}]}');
        await c.advance(12000);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT'), undefined);
        await c.advance(590000);
        const result = c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT');
        assert.equal(result?.text, undefined);
        assert.match(result?.error, /Timed out waiting for a valid/);
    } finally { c.dom.window.close(); }
});

test('response extraction tolerates surrounding text and braces inside quoted answers', async () => {
    const expected = { answers: [{ questionKey: 'q', answers: [{ answerText: 'a } \" b { c' }] }] };
    const c = chat({ workLayout: 'completed', workHeading: true, reply: () => 'ChatGPT said:\n```json\n' + JSON.stringify(expected) + '\n```\nCopy' });
    try {
        c.deliver(); await c.advance(6500);
        assert.deepEqual(JSON.parse(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text), expected);
    } finally { c.dom.window.close(); }
});

test('Work final answer outside the state subtree is still read', async () => {
    const c = chat({ workLayout: 'completed', workHeading: true, workLabelOnly: true });
    try {
        c.deliver(); await c.advance(400);
        const state = c.w.document.querySelector('[data-talvt-turn-state]');
        const answer = c.w.document.createElement('div');
        answer.textContent = '{"answers":[{"index":3,"questionKey":"q2_f8b48aec7052c3def70094efcc05f5d4","answers":[{"answerKey":"1947483719","answerText":"Аферист"}]}]}';
        state.after(answer);
        await c.advance(6500);
        const result = c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT');
        assert.equal(result?.text, answer.textContent);
        assert.equal(result?.error, undefined);
    } finally { c.dom.window.close(); }
});

test('final message sibling is read instead of the first assistant reasoning body', async () => {
    const c = chat({ reply: () => 'Thinking about the questions...' });
    try {
        c.deliver(); await c.advance(400);
        const answer = c.w.document.createElement('div');
        answer.dataset.messageAuthorRole = 'assistant';
        answer.innerHTML = '<pre><code>{"answers":[{"questionKey":"Q3","answers":[{"answerText":"Шулер"}]}]}</code></pre>';
        c.w.document.querySelector('article').appendChild(answer);
        await c.advance(6500);
        assert.equal(JSON.parse(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text).answers[0].questionKey, 'Q3');
    } finally { c.dom.window.close(); }
});

test('latest new assistant message is selected after an intermediate assistant message', async () => {
    const c = chat({ reply: () => 'Thinking about the questions...' });
    try {
        c.deliver(); await c.advance(400);
        const final = c.w.document.createElement('article');
        final.innerHTML = '<div data-message-author-role="assistant"><pre>{"answers":[]}</pre></div><button data-testid="copy-turn-action-button"></button>';
        c.w.document.body.appendChild(final);
        await c.advance(6500);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('completed placeholder does not fail while a delayed final response is still pending', async () => {
    const c = chat({ workLayout: 'completed', workHeading: true, workLabelOnly: true });
    try {
        c.deliver(); await c.advance(45000);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT'), undefined);
        const final = c.w.document.createElement('div');
        final.setAttribute('data-markdown', '');
        final.textContent = '{"answers":[{"questionKey":"Q3","answers":[{"answerText":"Шулер"}]}]}';
        c.w.document.querySelector('[data-turn-key]').appendChild(final);
        await c.advance(6500);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, final.textContent);
        assert.equal(c.sends, 1);
    } finally { c.dom.window.close(); }
});

test('completed intermediate assistant message waits for the later final message', async () => {
    const c = chat({ reply: () => 'Thinking...' });
    try {
        c.deliver(); await c.advance(30000);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT'), undefined);
        const final = c.w.document.createElement('article');
        final.innerHTML = '<div data-message-author-role="assistant">{"answers":[]}</div><button data-testid="copy-turn-action-button"></button>';
        c.w.document.body.appendChild(final);
        await c.advance(6500);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('an assistant response without the current user turn cannot complete the request', async () => {
    const c = chat();
    try {
        c.deliver(); await c.advance(400);
        const user = c.w.document.querySelector('[data-message-author-role="user"]');
        user.remove();
        await c.advance(15000);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT'), undefined);
        c.w.document.querySelector('article').before(user);
        await c.advance(6500);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});

test('a ChatGPT response taking eight minutes still completes without resending', async () => {
    const c = chat({ reply: () => 'Thinking...' });
    try {
        c.deliver(); await c.advance(8 * 60 * 1000);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT'), undefined);
        const final = c.w.document.createElement('article');
        final.innerHTML = '<div data-message-author-role="assistant">{"answers":[]}</div><button data-testid="copy-turn-action-button"></button>';
        c.w.document.body.appendChild(final);
        await c.advance(6500);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
        assert.equal(c.sends, 1);
    } finally { c.dom.window.close(); }
});

test('configured one-minute timeout replaces the default ten-minute timeout', async () => {
    const c = chat({ answerTimeoutMs: 60000, reply: () => 'Thinking...' });
    try {
        c.deliver(); await c.advance(59000);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT'), undefined);
        await c.advance(3000);
        assert.match(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.error, /Timed out/);
        assert.equal(c.sends, 1);
    } finally { c.dom.window.close(); }
});

test('configured longer timeout allows a response after the former ten-minute deadline', async () => {
    const c = chat({ answerTimeoutMs: 25 * 60000, reply: () => 'Thinking...' });
    try {
        c.deliver(); await c.advance(11 * 60000);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT'), undefined);
        const final = c.w.document.createElement('article');
        final.innerHTML = '<div data-message-author-role="assistant">{"answers":[]}</div><button data-testid="copy-turn-action-button"></button>';
        c.w.document.body.appendChild(final);
        await c.advance(6500);
        assert.equal(c.messages.find(m => m.type === 'PARAMEXT_CHATGPT_RESULT')?.text, '{"answers":[]}');
    } finally { c.dom.window.close(); }
});
