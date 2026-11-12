import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram, splitStatements, cleanSelector } from '../src/dsl.ts';

const p = (s: string) => parseProgram(s).map((x) => [x.verb, ...x.args, ...(Object.keys(x.opts).length ? [x.opts] : [])]);

test('call syntax with single quotes', () => {
  assert.deepEqual(p("open('shop.example/x'); fill('Search', 'usb hub'); submit(); find('price under $30')"), [
    ['open', 'shop.example/x'], ['fill', 'Search', 'usb hub'], ['submit'], ['find', 'price under $30'],
  ]);
});

test('numeric refs in every spelling', () => {
  assert.deepEqual(p("click(12); click('12'); click(@12); click('@e12'); click([12]); click(#12)"), [
    // quoted digits are still the number, and remembered as quoted: a control that reads "12" is preferred to number 12
    ['click', 12], ['click', 12, { _quoted: true }], ['click', 12], ['click', 12], ['click', 12], ['click', 12],
  ]);
});

test('shell syntax and newlines', () => {
  assert.deepEqual(p('open news.ycombinator.com\nfind show hn\nclick 14\nfill 5 hello world\nclick Sign in'), [
    ['open', 'news.ycombinator.com'], ['find', 'show hn'], ['click', 14], ['fill', 5, 'hello world'], ['click', 'Sign in'],
  ]);
});

test('a bare url is open', () => {
  assert.deepEqual(p('https://example.com/a?b=1;c=2'), [['open', 'https://example.com/a?b=1;c=2']]);
  assert.deepEqual(p('example.com'), [['open', 'example.com']]);
});

test('urls with semicolons, colons and equals inside quotes survive', () => {
  assert.deepEqual(p("open('https://example.com/a;b?x=1&y=2#frag'); read()"), [['open', 'https://example.com/a;b?x=1&y=2#frag'], ['read']]);
  assert.deepEqual(p('open https://example.com/a?x=1&y=2'), [['open', 'https://example.com/a?x=1&y=2']]);
});

test('playwright spellings', () => {
  assert.deepEqual(p("await page.goto('https://x.test'); await page.getByRole('button', { name: 'Sign in' }).click(); await page.getByLabel('Email').fill('a@b.c'); await page.keyboard.press('Enter')"), [
    ['open', 'https://x.test'], ['click', 'Sign in'], ['fill', 'Email', 'a@b.c'], ['press', 'Enter'],
  ]);
  assert.deepEqual(p("page.click('text=Log in'); page.fill('input[name=\"q\"]', 'cats'); page.locator('#submit-btn').click(); page.goBack()"), [
    ['click', 'Log in'], ['fill', 'q', 'cats'], ['click', 'submit btn'], ['back'],
  ]);
  assert.deepEqual(p("expect(page.getByText('Order placed')).toBeVisible()"), [['expect', 'Order placed']]);
  assert.deepEqual(p("await expect(page.locator('h1')).toHaveText('Welcome')"), [['expect', 'h1', 'Welcome']]);
});

test('named arguments', () => {
  assert.deepEqual(p("click('Add to basket', near='Sapiens'); click('Add', {near: 'Sapiens'}); find('x', budget=400)"), [
    ['click', 'Add to basket', { near: 'Sapiens' }], ['click', 'Add', { near: 'Sapiens' }], ['find', 'x', { budget: 400 }],
  ]);
});

test('aliases', () => {
  assert.deepEqual(p("navigate('a.test'); type(3, 'x'); snapshot(); screenshot(); goBack(); sleep(500); assert('ok')"), [
    ['open', 'a.test'], ['fill', 3, 'x'], ['view'], ['shot'], ['back'], ['wait', 500], ['expect', 'ok'],
  ]);
});

test('press accepts either argument order', () => {
  assert.deepEqual(p("press('Enter', 5); press(5, 'Enter')"), [['press', 'Enter', 5], ['press', 'Enter', 5]]);
});

test('quotes inside values and escapes', () => {
  assert.deepEqual(p(`fill('Comment', "it's fine; really"); fill(3, 'say \\'hi\\'')`), [['fill', 'Comment', "it's fine; really"], ['fill', 3, "say 'hi'"]]);
});

test('pipes between steps', () => {
  assert.deepEqual(p("open example.com | find 'pricing'"), [['open', 'example.com'], ['find', 'pricing']]);
});

test('unknown verb gives a suggestion', () => {
  assert.throws(() => parseProgram("clik(3)"), (e: any) => /did you mean click/.test(e.hint));
  assert.throws(() => parseProgram("frobnicate('x')"), /unknown verb/);
  assert.throws(() => parseProgram("   "), /empty program/);
});

test('comments and numbering are ignored', () => {
  assert.deepEqual(p("// first\n1. open('a.test')\n# then\n2. read()"), [['open', 'a.test'], ['read']]);
});

test('splitStatements respects brackets and quotes', () => {
  assert.deepEqual(splitStatements("a('x;y'); b({k: 'v;w'})\nc()"), ["a('x;y')", "b({k: 'v;w'})", 'c()']);
});

test('cleanSelector', () => {
  assert.equal(cleanSelector('text=Sign in'), 'Sign in');
  assert.equal(cleanSelector('button:has-text("Buy now")'), 'Buy now');
  assert.equal(cleanSelector('[aria-label="Close"]'), 'Close');
  assert.equal(cleanSelector('#search-input'), 'search input');
});
