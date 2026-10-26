const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function page(problems) {
    const body = problems.map((html, index) => `<div class="xblock-student_view-problem"><div class="problems-wrapper" data-url="/handler/${index}" data-problem-id="p${index}"><div class="problem">${html}</div><button class="submit">Отправить</button></div></div>`).join('');
    const dom = new JSDOM('<!doctype html><body>' + body, { url: 'https://courses.openedu.ru/xblock/test', runScripts: 'outside-only' });
    const w = dom.window;
    w.chrome = { runtime: { onMessage: { addListener() {} } } };
    w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 800, height: 30, top: 0, left: 0 });
    for (const file of ['platform_settings', 'openedu_shared', 'openedu_course_api', 'openedu_parser', 'openedu_ai', 'openedu_content']) {
        let code = fs.readFileSync(require.resolve('../js/' + file + '.js'), 'utf8');
        if (file === 'openedu_content') code = code.replace('    boot();', 'window.__test = { parseQuestions, buildQuestionAiExport, buildAiPromptText };');
        w.eval(code);
    }
    const questions = w.__test.parseQuestions();
    const items = questions.map((question, index) => ({ question, index }));
    return { dom, w, questions, export: () => w.__test.buildQuestionAiExport(items) };
}

const input = (id, value = '') => `<span class="textline"><input type="text" id="input_${id}" name="input_${id}" value="${value}"><span class="status incorrect">Неверно</span><p class="answer" id="answer_${id}">secret feedback</p></span>`;

test('AI export preserves the sentence on both sides of an inline blank instead of only its instruction', () => {
    const p = page([`<div class="wrapper-problem-response"><label class="problem-group-label" for="input_one">Вставьте пропущенное слово</label><div>Способность <strong>понимать</strong> чувства ${input('one', 'old wrong guess')} другого человека называется эмпатией.</div><p>Укажите термин в именительном падеже.</p></div>`]);
    try {
        assert.equal(p.questions.length, 1);
        const oldPrompt = p.questions[0].prompt, oldKey = p.questions[0].questionKey;
        const exported = p.export()[0];
        assert.match(exported.prompt, /Способность понимать чувства \[ANSWER 1\] другого человека называется эмпатией/);
        assert.ok(exported.prompt.includes('Укажите термин в именительном падеже.'));
        assert.ok(!exported.prompt.includes('old wrong guess'));
        assert.ok(!exported.prompt.includes('secret feedback'));
        assert.equal(exported.questionKey, oldKey);
        assert.equal(p.questions[0].prompt, oldPrompt);
        assert.equal(p.questions[0].questionKey, oldKey);
        assert.match(p.w.__test.buildAiPromptText([{ question: p.questions[0], index: 0 }]), /другого человека называется эмпатией/);
    } finally { p.dom.window.close(); }
});

test('multiple blanks retain the shared sentence and identify a different target for each question', () => {
    const p = page([`<div class="wrapper-problem-response"><p>Вставьте пропущенные слова</p><div>Общение бывает ${input('verbal')} и ${input('nonverbal')}, а интонация относится к паралингвистическим средствам.</div></div>`]);
    try {
        assert.equal(p.questions.length, 2);
        const exports = p.export();
        const first = exports.find(q => q.prompt.includes('Заполни только [ANSWER 1]'));
        const second = exports.find(q => q.prompt.includes('Заполни только [ANSWER 2]'));
        assert.ok(first); assert.ok(second);
        assert.match(first.prompt, /Общение бывает \[ANSWER 1\] и \[BLANK 2\], а интонация/);
        assert.match(second.prompt, /Общение бывает \[BLANK 1\] и \[ANSWER 2\], а интонация/);
    } finally { p.dom.window.close(); }
});

test('a blank prompt stays within its own LMS problem and excludes extension and grading UI', () => {
    const p = page([
        `<h3>Вставьте слово</h3><div class="problem-progress">0/1 points</div><div class="wrapper-problem-response"><p>Восприятие эмоций ${input('local')} связано с эмпатией.</p><div class="moodush-openedu-inline-menu">MooDuSh insert answers</div><div class="submission-feedback">attempts used</div></div>`,
        '<div class="wrapper-problem-response"><fieldset><legend>UNRELATED NEXT QUESTION</legend><input type="radio" name="choice" id="choice" value="a"><label for="choice">Option A</label></fieldset></div>'
    ]);
    try {
        const exported = p.export().find(q => q.prompt.includes('[ANSWER 1]'));
        assert.ok(exported);
        for (const noise of ['UNRELATED NEXT QUESTION', 'MooDuSh', 'secret feedback', '0/1 points', 'attempts used', 'Отправить']) assert.ok(!exported.prompt.includes(noise), noise);
    } finally { p.dom.window.close(); }
});

test('choice-only exports retain their existing prompt', () => {
    const p = page(['<div class="wrapper-problem-response"><fieldset><legend>Choose one</legend><input type="radio" name="choice" id="choice" value="a"><label for="choice">Alpha</label></fieldset></div>']);
    try { assert.equal(p.export()[0].prompt, p.questions[0].prompt); }
    finally { p.dom.window.close(); }
});

test('sentence paragraphs outside the narrow input wrapper are included', () => {
    const p = page([`<p>Эмпатия означает понимание чувств другого человека.</p><div class="wrapper-problem-response"><label class="problem-group-label" for="input_term">Вставьте пропущенное слово</label><div>${input('term')}</div></div><p>Назовите описанную способность одним словом.</p>`]);
    try {
        assert.equal(p.questions.length, 1);
        const prompt = p.export()[0].prompt;
        assert.match(prompt, /Эмпатия означает понимание чувств другого человека/);
        assert.match(prompt, /Назовите описанную способность одним словом/);
        assert.ok(prompt.includes('[ANSWER 1]'));
    } finally { p.dom.window.close(); }
});
