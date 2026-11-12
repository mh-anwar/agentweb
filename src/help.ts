// help(): the steps that are not worth paying for on every turn. The tool description carries the
// core language (it is sent with every request); everything else is one call away, by topic.
// Keep each topic to what an agent needs to write the step correctly: syntax first, one line of why.

export const HELP_TOPICS: Record<string, { about: string; text: string }> = {
  input: {
    about: 'double and right click, drag, hover, keys, dialogs, uploads, file drop',
    text: `A target is a number, visible text, or a test id: click('save-button') and click(testid='save-button') find data-testid="save-button" (also data-test, data-cy, data-qa).
By role, when a text names several kinds of control: click(role='button', name='Save') · fill(role='textbox', name='Email', 'a@b.co') · click(role='link', name='Docs', nth=2) · click(role='checkbox') when the page has one. Roles: button, link, textbox, checkbox, radio, combobox, tab, menuitem.
click(t, double=1) · click(t, button='right') · hover(t) · drag(a, b) · press('Control+A') · press('Enter', 12)
upload(t, 'path/to/file') · drop(t, 'path/to/file') (drop a file onto an element)
dialog('accept') / dialog('dismiss') / dialog('accept', 'text for a prompt') - set BEFORE the step that opens the alert/confirm
scroll('bottom') / scroll('top') / scroll(600) · forward() · reload()`,
  },
  wait: {
    about: 'waiting for a URL, one of several texts, text to go away, an element state',
    text: `wait('text') · wait(2) seconds · wait('Saved', 'Failed') whichever comes first (says which)
wait(url='/dashboard') ('*' globs) · wait(gone='Loading') · wait(12, state='hidden'|'visible'|'enabled') · any of them with timeout=20
expect('text') also waits (up to 5 s; timeout=10) and stops the program if it fails: expect(not='Error'), expect(url='/cart'), expect(title='Cart'), expect('Item', n=3)`,
  },
  emulate: {
    about: 'phone or tablet, viewport, locale, timezone, location, dark mode, slow network',
    text: `emulate('iPhone 15') · emulate(390, 844) · emulate(locale='fr-FR', tz='Europe/Paris', geo='48.85,2.35', dark=1)
emulate(throttle='slow3g'|'fast4g'|'off', cpu=4) · emulate(motion='reduce', contrast='more', forced_colors=1) · emulate(permissions='clipboard-read,notifications')
emulate() resets. These need the real browser and move the page there.`,
  },
  network: {
    about: 'mock or block requests, extra headers, HTTP basic auth, init scripts, console and network logs, HAR',
    text: `route('*/api/cart*', status=500, body='boom') · route('*/api/user', json='{"name":"x"}') · route('*.png', abort=1) · route('*/api/*', off=1) · route(off=1) · routes()
headers('X-Debug: 1', 'Accept-Language: fr') · headers(off=1) · auth('user', 'pass') (HTTP basic; the password may be a {{secret:name}})
init('window.__TEST__ = true') runs before the page's own scripts on every load · init(off=1)
console() · console('words', errors=1) · network('words', failed=1) · network('api', body=1) · network(har='name') saves a HAR file
Routes and init scripts need the real browser; headers and auth work everywhere.`,
  },
  tabs: {
    about: 'several pages open at once; the user\'s own browser',
    text: `tabs() lists · tab('new', 'url') · tab(2) · tab('close') · tab('close', 2). Tabs of one session share its cookies; each keeps its page, history and live state.
The \`session\` argument of the tool is different: a separate browser with its own cookies.
engine('mine') - this session's pages open in the user's own browser with their sign-ins (they must have the agentweb extension); engine('auto') goes back. Act only on what was asked there.
tab('shared') - take over a tab the user shared from the extension (tab('shared', 'title words') picks one); tab('close') gives it back, still open.
handoff('Please sign in') - only in the user's own browser: brings the tab to the front, notifies them, waits (wait=90 seconds) until the page changes, then shows it. For sign-ins, captchas and two-factor prompts.`,
  },
  signin: {
    about: 'saved sign-ins, cookies, stored credentials',
    text: `profile('name') loads a saved sign-in (a Playwright storageState file in ~/.config/agentweb/profiles); profile('name', save=1) saves the current one
login('NAME') signs in with a stored credential: opens its site, finds the sign-in form (also one that asks for the user name first), types user name and password, submits. login('NAME', url='https://site/login') when the form is elsewhere, user='…' when no user name is stored. It types only on the site the credential is bound to.
cookies() lists this session's cookies · fill(t, '{{secret:NAME}}') types a stored credential you never see`,
  },
  extract: {
    about: 'structured rows across pages, comparing a list between visits, opening many links',
    text: `records('words', pages=3) - matching list items / rows, following Next
collect(name='link', price='money', pages=3) - JSON rows with evidence and coverage; rules: text, link, url, money, number. Check coverage.complete.
collect(..., diff='catalog', key='href') - what was added, removed or changed since the last complete collection with that name
each('link words', find='words', n=8) - open matching links at once and show the matching lines of each
extract(...) · links('words') · outline() - headings with section sizes · read('Section name') · read(url, outline=1)`,
  },
  site: {
    about: 'all the URLs of a site, crawling them, llms.txt',
    text: `map() or map('docs.example.com', match='/docs/', depth=2, max=200) - URLs from the sitemap, else a bounded walk; map(save=1) keeps the list
each('words', find='words', crawl=1) · collect(name='text', crawl=1, max=20) - visit the saved map, with a coverage receipt
read('llms') opens the site's /llms.txt (read('llms-full') for the long one)`,
  },
  programs: {
    about: 'saved programs you can run by name; scheduled runs',
    text: `program('price-check', save="open('shop.example'); find('{item}')") · program('price-check', item='usb hub') · programs() · program('name', show=1) · program('name', delete=1)
schedule() - what the user's scheduled programs found last; schedule('name', n=3) for recent runs. Schedules are added by the user on the command line (agentweb schedule add NAME "daily 09:00" "program"), never from here.`,
  },
  shots: {
    about: 'screenshots at several widths, numbered screenshots, PDF, GIF recording',
    text: `shot() viewport · shot(full=1) whole page · shot(12) one element · shot(save=1) keeps the file and prints its path · shot(pdf=1) / pdf() saves a PDF
shot(widths='375,768,1280', save=1) one picture per width · shot(annotate=1) draws the element numbers of the text view on the picture
record('name') ... record(stop=1) saves the page as an animated GIF (at most 30 s) and prints its path`,
  },
  checks: {
    about: 'layout overflow, accessibility audit, console and request errors, as steps or as assertions',
    text: `overflow() - does the page scroll sideways, and which elements stick out (at most 5 lines); overflow(clipped=1) adds text cut off by its box; overflow(widths='375,768')
audit() - a built-in WCAG 2.2 AA subset (not axe-core): alt, labels, names, lang, title, ids, headings, main, tabindex, contrast, target size, aria-hidden. audit('contrast,names') limits it; audit(axe=1) runs axe-core if it is installed
expect(overflow=0) · expect(audit=0) · expect(audit='names,alt') · expect(console=0) (console='warn' includes warnings) · expect(requests=0); allow='favicon,hot-update' ignores matching lines; all=1 covers every page of the session
These run in the real browser and move the page there.`,
  },
  engines: {
    about: 'which engine loads the page: plain HTTP, scripts without a browser, Chrome, Firefox, WebKit',
    text: `Pages load on the cheapest engine that works: wire (HTTP, no scripts) → ghost (the page's scripts, no real browser) → chrome. It moves up on its own when a page needs it.
engine('chrome') / engine('firefox') / engine('webkit') / engine('ghost') / engine('wire') pins one; engine('auto') unpins. The page header shows the engine in brackets.`,
  },
  testing: {
    about: 'writing end-to-end tests the user can run without a model',
    text: `Put steps in a file: tests/shop.aw
  # base: http://localhost:3000        (also # profile: name, # engine: chrome, # timeout: 10, # setup: / # teardown: shell commands)
  ## cart starts empty
  open('/cart'); expect('Your cart is empty'); expect(url='/cart'); expect(not='Error')
Run: agentweb test [files] [--engine chrome] [--verbose] [--json]. A pass is one line; a failure is the step, the error and a few lines of the page.
snapshot('name') compares the page's text with a saved baseline (--update accepts). screenshot('name', widths='375,768') does the same with pictures. # console: clean fails any test whose pages logged errors. expect(overflow=0) and expect(audit=0): see help('checks'). exec('cmd', as='otp') runs a command and keeps its output as \${otp} (test files only).
agentweb test --record out.aw "program" saves a passing program as a test.`,
  },
  bug: {
    about: 'report a bug in this tool',
    text: `bug('what you expected | what happened') - alone in a call it reports your previous call, with other steps that call. Saved: the program (typed secrets masked), the engine and the status lines. Never page text.`,
  },
};

const ALIASES: Record<string, string> = {
  click: 'input', drag: 'input', dialog: 'input', keys: 'input', upload: 'input', hover: 'input', scroll: 'input',
  expect: 'wait', waiting: 'wait',
  device: 'emulate', mobile: 'emulate', viewport: 'emulate', throttle: 'emulate', locale: 'emulate',
  route: 'network', mock: 'network', headers: 'network', auth: 'network', init: 'network', console: 'network', har: 'network', requests: 'network',
  tab: 'tabs', mine: 'tabs', browser: 'tabs', extension: 'tabs',
  login: 'signin', profile: 'signin', cookies: 'signin', secrets: 'signin', auth_state: 'signin',
  collect: 'extract', records: 'extract', each: 'extract', data: 'extract', read: 'extract', outline: 'extract',
  map: 'site', crawl: 'site', sitemap: 'site', llms: 'site',
  program: 'programs', schedule: 'programs', schedules: 'programs', saved: 'programs',
  shot: 'shots', screenshot: 'shots', pdf: 'shots', record: 'shots', gif: 'shots', annotate: 'shots', widths: 'shots',
  overflow: 'checks', audit: 'checks', a11y: 'checks', accessibility: 'checks', layout: 'checks',
  engine: 'engines', chrome: 'engines', firefox: 'engines', webkit: 'engines', safari: 'engines',
  test: 'testing', tests: 'testing',
  bugs: 'bug', report: 'bug',
};

/** Extra topics registered by verb packs (so a pack documents its own verbs). */
export function addHelpTopic(name: string, about: string, text: string, aliases: string[] = []): void {
  HELP_TOPICS[name] = { about, text };
  for (const a of aliases) ALIASES[a] = name;
}

export function helpText(topic?: string): string {
  const t = (topic ?? '').toLowerCase().trim();
  if (!t) return 'More steps, by topic. help(\'topic\') shows the syntax:\n' + Object.entries(HELP_TOPICS).map(([k, v]) => `${k} - ${v.about}`).join('\n');
  const key = HELP_TOPICS[t] ? t : ALIASES[t];
  if (key) return `${key}\n${HELP_TOPICS[key].text}`;
  // a word from somewhere in the help: show the topics that mention it
  const hits = Object.entries(HELP_TOPICS).filter(([k, v]) => (k + ' ' + v.about + ' ' + v.text).toLowerCase().includes(t));
  if (hits.length === 1) return `${hits[0][0]}\n${hits[0][1].text}`;
  if (hits.length) return `'${topic}' is mentioned in: ${hits.map(([k]) => k).join(', ')}. help('${hits[0][0]}') shows it.`;
  return `no help topic '${topic}'. Topics: ${Object.keys(HELP_TOPICS).join(', ')}`;
}
