// UI check for deck.html against a fixed set of agents, driven the way the app shell drives it.
//   PATH=~/.local/node/bin:$PATH node app/test.cjs [screenshot-dir]
const path = require('path');
const assert = require('assert');
const pw = require(process.env.HOME + '/personal/3d-tetris/node_modules/playwright');  // ponytail: borrows another project's Playwright; give this folder its own if that one moves

const shots = process.argv[2];
const now = Date.now() / 1000;
const agent = (o) => ({ win: 0, window: null, branch: '', sid: 's-' + o.id, moved: now, prompt: '', note: '', doing: '', said: '', subs: 0, cut: false, cwd: '/x', pid: 1, tabid: o.pane, ...o });
const projects = [{ name: 'harvestcrown', path: '/p/harvestcrown' }, { name: 'sea-game', path: '/p/sea-game' }, { name: 'agentdeck', path: '/p/agentdeck' }];
const rows = () => [
  agent({ id: 'b1', kind: 'claude', state: 'blocked', since: now - 190, title: '<img src=x onerror="window.pwned=1"> Payments refactor', proj: 'vivaa', tab: 7, pane: 70,
    prompt: 'Split the ledger service', note: 'permission request',
    said: 'I need to run a migration.\n\n<script>window.pwned=1</script>\n\n**Approve** the `DROP INDEX`? See [the plan](javascript:window.pwned=1).' }),
  agent({ id: 'y1', kind: 'codex', state: 'yours', since: now - 8 * 3600, title: 'Inspect model', proj: 'codex-sea-game', tab: 5, pane: 50, subs: 2,
    prompt: 'You can use the blender MCP too',
    said: 'Built **LAST LIGHT**, a complete 3D ocean rescue game.\n\n**[Play now](http://localhost:4173)** — recover three survivors.\n\nAll **8 acceptance criteria passed**:\n\n- Static build: `npm run build` succeeds.\n- Boat mechanics: 8 simulation tests pass.\n- Reliability: 4 browser tests pass.' }),
  agent({ id: 'y2', kind: 'claude', state: 'yours', since: now - 60, title: 'Empire game with Catan aesthetic', proj: 'harvestcrown', tab: 2, pane: 20,
    note: 'background shell running', prompt: 'How is it going?', said: 'Four tickets are running; I will integrate them as they land.' }),
  agent({ id: 'w1', kind: 'claude', state: 'working', since: now - 780, title: 'Multi-agent context manager', proj: 'agentdeck', tab: 3, pane: 30,
    doing: '→ Bash: Run the UI checks', prompt: 'Take this to the next level', said: 'The deck interface is rendering.' }),
  agent({ id: 'w2', kind: 'exec', state: 'working', since: now - 3700, title: 'INT-D · gpt-6.1-sol high build', proj: 'harvestcrown', tab: null, pane: null,
    said: 'The remaining 720p walks are still clean.' }),
  agent({ id: 'w3', kind: 'exec', state: 'working', since: now - 3600, title: 'GX-K · gpt-6.1-sol high build', proj: 'harvestcrown', tab: null, pane: null }),
  agent({ id: 'w4', kind: 'codex', state: 'working', since: now - 500, title: 'Restart Docker Desktop preserving', proj: 'voidreach', tab: 1, pane: 10, subs: 3,
    said: 'The Linux backup-suite run has started.' }),
  agent({ id: 'd1', kind: 'exec', state: 'done', since: now - 200, title: 'UX-8 · gpt-6.1-sol high build', proj: 'harvestcrown', tab: null, pane: null,
    said: 'All replay checks pass at 1600×900 and 1280×720.' }),
];
const backdrop = `html{background:
  repeating-linear-gradient(180deg, rgba(205,214,244,.16) 0 2px, transparent 2px 19px),
  radial-gradient(900px 500px at 20% 10%, #45475a, transparent), radial-gradient(700px 600px at 90% 90%, #5b4a7a, transparent), #1e1e2e;}`;

(async () => {
  const browser = await pw.webkit.launch().catch(() => pw.chromium.launch());
  const open = async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(String(e)));
    await page.addInitScript(() => { window.msgs = []; window.webkit = { messageHandlers: { deck: { postMessage: (m) => { window.msgs.push(m); if (m.cmd === 'send') window.lastSend = m; if (m.cmd === 'launch') window.lastLaunch = m; } } } }; });
    await page.goto('file://' + path.join(__dirname, 'deck.html'));
    await page.addStyleTag({ content: backdrop });
    await page.evaluate((r) => deck.update({ rows: r }, {}), rows());
    return page;
  };
  const msgs = (page, cmd) => page.evaluate(() => window.msgs.splice(0)).then((all) => cmd ? all.filter((m) => m.cmd === cmd) : all);
  const sel = (page) => page.evaluate(() => document.querySelector('.row.sel')?.dataset.id ?? null);
  const order = (page) => page.evaluate(() => [...document.querySelectorAll('.row')].map((r) => r.dataset.id));
  const draft = (page) => page.inputValue('#r');
  const sends = (page) => msgs(page, 'send').then((all) => all.map(({ id, text, submit }) => ({ id, text, submit })));

  const page = await open(900, 580);
  await page.evaluate(() => deck.show('palette', { hotkey: '⌥Space' }));

  // everything that wants you first, then working agents by project, then finished runs
  assert.deepEqual(await order(page), ['b1', 'y1', 'y2', 'w1', 'w2', 'w3', 'w4', 'd1']);
  assert.equal(await sel(page), 'b1', 'opens on the most urgent agent');

  // nothing an agent wrote becomes markup, and its links go to the app as plain strings for the app to judge
  assert.equal(await page.evaluate(() => document.querySelectorAll('#deck img, #deck script, #deck a').length), 0);
  assert.ok((await page.textContent('#head h1')).includes('<img'));
  await msgs(page);
  await page.click('#said .link');
  assert.deepEqual(await msgs(page, 'open'), [{ cmd: 'open', url: 'javascript:window.pwned=1' }]);
  assert.equal(await page.evaluate(() => window.pwned), undefined);

  // a blocked agent: no reply box, and its terminal is fetched so the question can be read here
  assert.equal(await page.evaluate(() => document.getElementById('r').disabled), true);
  await page.evaluate(() => deck.screen('b1', 'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No'));
  assert.ok((await page.textContent('#screen')).includes('Do you want to proceed?'));
  if (shots) await page.screenshot({ path: shots + '/deck-blocked.png' });

  // a draft belongs to the agent it was typed for; arrows inside the box edit text, they do not change who gets it
  await page.keyboard.press('ArrowDown');
  assert.equal(await sel(page), 'y1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('ship it');
  await page.keyboard.press('Enter');  // a new line, not a send
  await page.keyboard.type('then tell me');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  assert.equal(await sel(page), 'y1', 'arrows in the reply box leave the selection alone');
  assert.equal(await draft(page), 'ship it\nthen tell me');
  assert.deepEqual(await msgs(page, 'send'), [], 'Return alone never sends');
  if (shots) await page.screenshot({ path: shots + '/deck-palette.png' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  assert.equal(await sel(page), 'y2');
  assert.equal(await draft(page), '', 'the next agent starts with an empty box');
  await page.keyboard.press('ArrowUp');
  assert.equal(await draft(page), 'ship it\nthen tell me', 'and the draft is waiting when you come back');

  // sending: the text stays until the app confirms; a failure keeps it, a success clears it and moves on
  await page.keyboard.press('Tab');
  await page.keyboard.press('Meta+Enter');
  assert.deepEqual(await sends(page), [{ id: 'y1', text: 'ship it\nthen tell me', submit: true }]);
  assert.equal(await page.evaluate(() => window.lastSend.sid), 's-y1', 'a send names the session it was written for');
  await page.keyboard.press('Meta+Enter');
  assert.deepEqual(await msgs(page, 'send'), [], 'no double send while one is in flight');
  await page.evaluate(() => deck.sent('y1', false, 'Not sent: it is working, not waiting for a prompt', window.lastSend.req));
  assert.equal(await draft(page), 'ship it\nthen tell me', 'a failed send loses nothing');
  assert.ok((await page.getAttribute('#toast', 'class')).includes('bad'));
  await page.keyboard.press('Meta+Enter');
  await msgs(page);
  await page.evaluate(() => deck.sent('y1', true, '', window.lastSend.req));
  assert.equal(await sel(page), 'b1', 'after a delivered reply, on to the next agent that needs you');
  assert.deepEqual(await msgs(page, 'seen'), [{ cmd: 'seen', id: 'y1', since: rows()[1].since }], 'a delivered reply counts as dealt with');

  // ⌘D marks a hand-back as dealt with; it sinks and stops counting
  await page.evaluate(() => deck.press('d', { meta: true }));
  const marked = await msgs(page, 'seen');
  assert.equal(marked.length, 1); assert.equal(marked[0].id, 'b1');
  assert.deepEqual((await order(page)).slice(0, 3), ['y2', 'b1', 'y1'], 'dealt-with agents sink below fresh ones');
  assert.ok(await page.evaluate(() => document.getElementById('row-b1').classList.contains('seen')));

  // paste-and-drop-in
  await page.evaluate(() => document.getElementById('row-y2').click());
  await page.keyboard.press('Tab');
  await page.keyboard.type('look at this');
  await page.keyboard.press('Shift+Meta+Enter');
  assert.deepEqual(await sends(page), [{ id: 'y2', text: 'look at this', submit: false }]);
  await page.evaluate(() => deck.sent('y2', true, '', window.lastSend.req));

  // what is shown can never outlive the data: a renamed agent that lost its terminal
  await page.evaluate((r) => { r[2].title = 'Renamed'; r[2].pane = null; r[2].tab = null; deck.update({ rows: r }, {}); }, rows());
  assert.equal(await page.textContent('#head h1'), 'Renamed');
  assert.equal(await page.evaluate(() => document.getElementById('r').disabled), true);
  assert.equal(await page.evaluate(() => document.getElementById('openBtn').hidden), true);

  // a filter that matches nothing leaves nothing selected, and Return does nothing
  await page.evaluate((r) => deck.update({ rows: r }, {}), rows());
  await page.click('#q'); await page.fill('#q', 'voidreach');
  assert.deepEqual(await order(page), ['w4']); assert.equal(await sel(page), 'w4');
  await page.evaluate((r) => { r[6].title = 'Something else'; r[6].proj = 'elsewhere'; r[6].said = ''; deck.update({ rows: r }, {}); }, rows());
  assert.deepEqual(await order(page), []); assert.equal(await sel(page), null);
  await msgs(page); await page.keyboard.press('Enter');
  assert.deepEqual(await msgs(page, 'jump'), []);
  await page.keyboard.press('Escape');
  assert.equal(await page.inputValue('#q'), '', 'escape clears the filter first');
  await page.keyboard.press('Escape');
  assert.deepEqual(await msgs(page, 'hide'), [{ cmd: 'hide' }]);

  // the recipient cannot change under someone who is typing, and a draft outlives its agent dropping out of an update
  await page.evaluate((r) => deck.update({ rows: r }, {}), rows());
  await page.click('#q'); await page.fill('#q', 'Inspect');
  assert.equal(await sel(page), 'y1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('still for y1');
  await page.evaluate((r) => { r[1].title = 'No longer matches'; deck.update({ rows: r }, {}); }, rows());
  assert.equal(await page.textContent('#head h1'), 'No longer matches', 'a feed update does not swap the agent while the reply box has focus');
  assert.equal(await draft(page), 'still for y1');
  await msgs(page); await page.keyboard.press('Meta+Enter');
  assert.deepEqual((await msgs(page, 'send')).map((m) => m.id), ['y1']);
  await page.evaluate(() => deck.sent('y1', false, 'Not sent: test', window.lastSend.req));
  await page.evaluate((r) => deck.update({ rows: r.filter((x) => x.id !== 'y1') }, {}), rows());
  assert.notEqual(await sel(page), 'y1');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'r', 'focus leaves the reply box when its agent goes');
  await page.fill('#q', '');
  await page.evaluate((r) => { deck.update({ rows: r }, {}); document.getElementById('row-y1').click(); }, rows());
  assert.equal(await draft(page), 'still for y1', 'the draft is still there when the agent comes back');
  await page.evaluate(() => { document.getElementById('r').value = ''; document.getElementById('r').dispatchEvent(new Event('input')); });

  // a focused button keeps its own Return; a dealt-with blocker stops counting
  await page.focus('#termBtn'); await msgs(page);
  await page.keyboard.press('Enter');
  assert.deepEqual(await msgs(page, 'jump'), []);
  assert.equal(await page.getAttribute('#termBtn', 'aria-pressed'), 'true');
  await page.keyboard.press('Enter');
  assert.ok((await page.textContent('#sum')).includes('blocked'));
  await page.evaluate((r) => deck.update({ rows: r }, { b1: r[0].since }), rows());
  assert.ok(!(await page.textContent('#sum')).includes('blocked'), 'a blocker marked seen is not counted');
  await page.evaluate((r) => deck.update({ rows: r }, {}), rows());

  // stale status turns replies off
  await page.evaluate(() => { document.getElementById('row-y1').click(); deck.stale(14); });
  assert.equal(await page.evaluate(() => document.getElementById('r').disabled), true);
  assert.ok((await page.textContent('#sum')).includes('14s old'));
  await page.evaluate((r) => deck.update({ rows: r }, {}), rows());
  assert.equal(await page.evaluate(() => document.getElementById('r').disabled), false);

  // ⌘1–9 are positions in the list, so they work whatever windows the tabs are in
  await page.evaluate(() => deck.show('palette', {}));  // numbers are handed out when the deck opens
  await msgs(page); await page.keyboard.press('Meta+2');
  assert.deepEqual(await msgs(page, 'jump'), [{ cmd: 'jump', id: 'y1' }]);
  await page.evaluate((r) => { r[3].window = 2; r[3].branch = 'feature/deck'; r[3].moved = Date.now() / 1000 - 900; deck.update({ rows: r }, {}); document.getElementById('row-w1').click(); }, rows());
  const where = await page.textContent('#head .where');
  assert.ok(where.includes('window 2 tab 3') && where.includes('⎇ feature/deck') && where.includes('quiet 15m'), where);

  // a busy agent: the reply is held and goes out the moment it finishes; a refusal turns it back into a draft and says so
  await page.click('#q'); await page.keyboard.press('Tab');
  await page.keyboard.type('then run the tests');
  await msgs(page); await page.keyboard.press('Meta+Enter');
  assert.deepEqual(await msgs(page, 'send'), [], 'nothing is typed into a busy agent');
  assert.ok((await page.textContent('#row-w1')).includes('reply queued'));
  assert.equal(await page.textContent('#sendBtn'), 'Cancel⌘↩');
  await page.evaluate((r) => deck.update({ rows: r }, {}), rows());
  assert.deepEqual(await msgs(page, 'send'), [], 'still busy: still held');
  await page.evaluate((r) => { r[3].state = 'yours'; deck.update({ rows: r }, {}); }, rows());
  assert.deepEqual(await sends(page), [{ id: 'w1', text: 'then run the tests', submit: true }]);
  await page.evaluate(() => deck.sent('w1', false, 'Not sent: its prompt is not empty', window.lastSend.req));
  const after = await msgs(page);
  assert.ok(after.some((m) => m.cmd === 'banner' && m.id === 'w1'), 'a queued reply that could not be sent raises a banner');
  await page.evaluate((r) => { r[3].state = 'yours'; deck.update({ rows: r }, {}); document.getElementById('row-w1').click(); }, rows());
  assert.deepEqual(await msgs(page, 'send'), [], 'a refused queued reply is not retried on its own');
  assert.equal(await draft(page), 'then run the tests', 'and its text is back in the box');
  await page.evaluate(() => { document.getElementById('r').value = ''; document.getElementById('r').dispatchEvent(new Event('input')); });

  // a queued reply belongs to one turn: interrupting that turn, or someone prompting the agent first, cancels it
  await page.evaluate((r) => { deck.update({ rows: r }, {}); document.getElementById('row-w4').click(); }, rows());
  await page.click('#q'); await page.keyboard.press('Tab');
  await page.keyboard.type('keep going'); await page.keyboard.press('Meta+Enter');
  await msgs(page);
  await page.evaluate((r) => { r[6].state = 'yours'; r[6].note = 'you interrupted it'; deck.update({ rows: r }, {}); }, rows());
  let out = await msgs(page);
  assert.ok(!out.some((m) => m.cmd === 'send') && out.some((m) => m.cmd === 'banner'), 'an interrupted turn does not get its queued reply');
  await page.evaluate((r) => { deck.update({ rows: r }, {}); document.getElementById('row-w4').click(); }, rows());
  assert.equal(await draft(page), 'keep going');
  await page.click('#q'); await page.keyboard.press('Tab'); await page.keyboard.press('Meta+Enter');
  assert.ok((await page.textContent('#row-w4')).includes('reply queued'));
  await page.evaluate((r) => { r[6].since += 50; deck.update({ rows: r }, {}); }, rows());
  await page.evaluate((r) => { r[6].since += 50; r[6].state = 'yours'; deck.update({ rows: r }, {}); }, rows());
  out = await msgs(page);
  assert.ok(!out.some((m) => m.cmd === 'send'), 'a new turn started first: the old queued reply is not sent after it');
  await page.evaluate((r) => { deck.update({ rows: r }, {}); document.getElementById('row-w4').click(); }, rows());
  await page.click('#r'); await page.keyboard.press('Meta+Enter');
  await page.evaluate((r) => { r[6].state = 'yours'; r[6].prompt = 'something else entirely'; deck.update({ rows: r }, {}); }, rows());
  assert.ok(!(await msgs(page)).some((m) => m.cmd === 'send'), 'nor if all we ever see is that its last prompt changed');
  await page.evaluate((r) => deck.update({ rows: r }, {}), rows());
  await page.click('#r'); await page.keyboard.press('Meta+Enter');   // queue it again, then take it back with the same key
  await page.click('#r'); await page.keyboard.press('Meta+Enter');
  assert.ok(!(await page.textContent('#row-w4')).includes('reply queued'), '⌘↩ on a queued reply cancels it');
  await page.evaluate(() => { document.getElementById('r').value = ''; document.getElementById('r').dispatchEvent(new Event('input')); });

  // an answer for some other request is ignored; no answer at all leaves the draft and never retries
  await page.evaluate(() => document.getElementById('row-y2').click());
  await page.click('#q'); await page.keyboard.press('Tab'); await page.keyboard.type('hello'); await msgs(page);
  await page.keyboard.press('Meta+Enter');
  await page.evaluate(() => deck.sent('y2', true, '', 424242));
  assert.equal(await draft(page), 'hello', 'a stray acknowledgement does not clear the box');
  await page.evaluate(() => deck.sent('y2', false, 'Not sent: test', window.lastSend.req));
  await page.evaluate(() => { deck.patience = 80; });
  await page.keyboard.press('Meta+Enter'); await msgs(page);
  await page.waitForTimeout(250);
  assert.ok((await page.textContent('#to')).includes('No confirmation'));
  assert.deepEqual(await sends(page), [], 'no automatic retry after silence');
  await page.evaluate(() => { deck.sent('y2', true, '', window.lastSend.req); deck.patience = 20000; });
  assert.equal(await draft(page), 'hello', 'a late answer to a request we gave up on changes nothing');
  await page.evaluate(() => { document.getElementById('r').value = ''; document.getElementById('r').dispatchEvent(new Event('input')); });

  // ⌘1–9 are fixed when the deck opens: marking the first agent seen reorders the list but not the numbers
  await page.evaluate((r) => { deck.update({ rows: r }, {}); deck.show('palette', {}); deck.update({ rows: r }, { b1: r[0].since }); }, rows());
  assert.equal((await order(page))[0], 'y1');
  await msgs(page); await page.keyboard.press('Meta+1');
  assert.deepEqual(await msgs(page, 'jump'), [{ cmd: 'jump', id: 'b1' }]);

  // words are handed to the app as you type, and come back as drafts after a restart; git's view of the selected agent is shown
  await page.evaluate(() => document.getElementById('row-y1').click());
  await page.click('#r'); await page.keyboard.type('half a thought'); await msgs(page);
  await page.waitForTimeout(600);
  const kept = await msgs(page, 'keep');
  assert.equal(kept[kept.length - 1].drafts.y1, 'half a thought');
  await page.evaluate(() => { document.getElementById('r').value = ''; document.getElementById('r').dispatchEvent(new Event('input')); deck.restore({ y2: 'from last time' }); document.getElementById('row-y2').click(); });
  assert.equal(await draft(page), 'from last time');
  await page.evaluate(() => { document.getElementById('r').value = ''; document.getElementById('r').dispatchEvent(new Event('input')); deck.changes('y2', { branch: 'main...origin/main [ahead 2]', files: [{ code: ' M', path: 'src/a.js' }, { code: '??', path: 'notes.md' }], commits: [], more: 0 }); });
  assert.equal(await page.textContent('#changedLabel'), 'Uncommitted files · 2 · ahead 2');

  // folding down to the strip shows every agent again, whatever the deck was filtered to
  await page.click('#q'); await page.fill('#q', 'voidreach');
  await page.evaluate(() => deck.show('dock', { pinned: true }));
  assert.equal((await order(page)).length, 8);
  await page.evaluate(() => deck.show('palette', {}));

  // starting a new agent: project by typing, the command shown before it runs, the prompt optional
  await page.evaluate((a) => deck.update({ rows: a[0], projects: a[1] }, {}), [rows(), projects]);
  await page.evaluate(() => deck.show('palette', { commands: { claude: 'claude --flag', codex: 'codex --flag' } }));
  await page.evaluate(() => document.getElementById('row-y1').click());
  await page.keyboard.press('Meta+n');
  assert.equal(await page.evaluate(() => document.getElementById('new').hidden), false);
  assert.equal(await page.inputValue('#nProj'), '/x', 'it starts from the exact folder the selected agent is in');
  await page.fill('#nProj', 'sea');
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#nProj'), 'sea-game');
  await page.keyboard.type('Add a harbour level');
  await page.click('#nCodex');
  assert.equal(await page.inputValue('#nCmd'), 'codex --flag');
  await msgs(page); await page.keyboard.press('Meta+Enter');
  await page.keyboard.press('Meta+Enter');  // a second press while the first is in flight must not start a second agent
  const launches = await msgs(page, 'launch');
  assert.deepEqual(launches.map(({ kind, dir, command, prompt }) => ({ kind, dir, command, prompt })), [{ kind: 'codex', dir: '/p/sea-game', command: 'codex --flag', prompt: 'Add a harbour level' }]);
  await page.evaluate(() => deck.launched(true, 'stale answer', -1));
  assert.equal(await page.evaluate(() => document.getElementById('new').hidden), false, 'an answer to some other launch changes nothing');
  await page.evaluate(() => deck.launched(false, 'No such folder', window.lastLaunch.rev));
  assert.equal(await page.textContent('#nWhy'), 'No such folder');
  await page.keyboard.press('Meta+Enter');
  await page.evaluate(() => deck.launched(true, 'Started codex in sea-game', window.lastLaunch.rev));
  assert.equal(await page.evaluate(() => document.getElementById('new').hidden), true);
  if (shots) { await page.keyboard.press('Meta+n'); await page.fill('#nProj', 'h'); await page.screenshot({ path: shots + '/deck-new.png' }); await page.keyboard.press('Escape'); }

  // a headless run has no tab
  await page.evaluate(() => document.getElementById('row-w2').click());
  await page.click('#q'); await page.keyboard.press('Enter');
  assert.deepEqual(await msgs(page, 'jump'), []);
  assert.deepEqual(page.errors, []);

  // the pinned strip: a row click drops straight in, its ⤢ opens the full deck on it, a headless row can only be inspected
  const strip = await open(320, 520);
  await strip.evaluate(() => deck.show('dock', { pinned: true, hotkey: '⌥Space' }));
  if (shots) await strip.screenshot({ path: shots + '/deck-dock.png' });
  const first = await msgs(strip);
  assert.ok(first.some((m) => m.cmd === 'height' && m.height > 100));
  await strip.click('#row-y1 .title');
  assert.deepEqual(await msgs(strip, 'jump'), [{ cmd: 'jump', id: 'y1' }]);
  await strip.evaluate(() => document.querySelector('#row-y2 .look').click());
  assert.deepEqual(await msgs(strip, 'expand'), [{ cmd: 'expand', id: 'y2' }]);
  await strip.click('#row-w2 .title');
  const headless = await msgs(strip);
  assert.ok(headless.some((m) => m.cmd === 'expand' && m.id === 'w2') && !headless.some((m) => m.cmd === 'jump'));
  await strip.click('#sum');
  assert.equal((await msgs(strip, 'expand')).length, 1, 'the strip header opens the full deck');
  await strip.click('#foldBtn');
  assert.deepEqual(await msgs(strip, 'fold'), [{ cmd: 'fold', on: true }]);
  assert.equal(await strip.evaluate(() => document.documentElement.scrollWidth), 320);
  // opening the strip into the full deck: the reply box, never laid out while hidden, must come up at a usable height
  await strip.setViewportSize({ width: 900, height: 580 });
  await strip.evaluate(() => deck.show('palette', { pinned: true, select: 'y1' }));
  assert.ok(await strip.evaluate(() => document.getElementById('r').clientHeight) >= 16, 'reply box is visible after expanding from the strip');
  assert.equal(await strip.evaluate(() => document.querySelector('.row.sel').dataset.id), 'y1');
  assert.deepEqual(strip.errors, []);

  // the pill: just the counts, a ring when something is new, a click unfolds it, a drag moves it
  const pill = await open(180, 36);
  await pill.evaluate(() => deck.show('pill', { pinned: true }));
  if (shots) await pill.screenshot({ path: shots + '/deck-pill.png' });
  assert.ok((await msgs(pill)).some((m) => m.cmd === 'width' && m.width > 60 && m.width < 180));
  assert.ok(await pill.evaluate(() => document.getElementById('deck').classList.contains('stuck')), 'a blocked agent rings the pill');
  assert.equal(await pill.evaluate(() => document.getElementById('list').offsetHeight), 0);
  await pill.mouse.click(60, 18);
  assert.deepEqual(await msgs(pill, 'fold'), [{ cmd: 'fold', on: false }]);
  await pill.mouse.move(60, 18); await pill.mouse.down(); await pill.mouse.move(90, 30, { steps: 3 }); await pill.mouse.up();
  const dragged = await msgs(pill);
  assert.ok(dragged.some((m) => m.cmd === 'move') && dragged.some((m) => m.cmd === 'moved') && !dragged.some((m) => m.cmd === 'fold'), 'a drag moves it and is not a click');
  assert.deepEqual(pill.errors, []);

  // the dashboard: the same agents in a real window, with the conversation, the changes and their diffs, and what happened
  const board = await open(1320, 860);
  await board.evaluate((r) => { r[1].branch = 'main'; deck.update({ rows: r }, { b1: r[0].since }); deck.show('board', { looked: Date.now() / 1000 - 600 }); }, rows());
  assert.equal(await sel(board), 'y1', 'opens on the first agent you have not dealt with');
  assert.deepEqual((await msgs(board, 'talk')).map((m) => m.id), ['y1'], 'asks for that agent\'s conversation');
  await board.evaluate(() => deck.talk('y1', [
    { you: 'One shot a 3D ocean game', at: Date.now() / 1000 - 30000, said: 'Plan agreed. **Building** now.', steps: 4 },
    { you: 'You can use the blender MCP too', at: Date.now() / 1000 - 29000, said: 'Built **LAST LIGHT**.\n\n- 8 criteria passed', steps: 212 },
  ]));
  const talk = await board.textContent('#talk');
  assert.ok(talk.includes('One shot a 3D ocean game') && talk.includes('212 tool calls') && talk.includes('Built LAST LIGHT.'), talk);
  assert.equal(await board.evaluate(() => document.querySelectorAll('#talk strong').length), 2);
  await board.evaluate(() => deck.talk('y1', [{ you: 'Do A', at: 1, said: 'A is half done', steps: 2, open: true }, { you: 'Status?', at: 2, said: '| Ticket | Since |\n|---|---|\n| Wiring | 09:53 |\n\nAll **good**.', steps: 1, ran: ['Run the unit tests', 'Build the app'] }]));
  assert.ok((await board.textContent('#talk')).includes('not finished when you wrote again') && (await board.textContent('#talk')).includes('What it ran · 2'));
  assert.deepEqual(await board.evaluate(() => [document.querySelectorAll('#talk th').length, document.querySelectorAll('#talk td').length]), [2, 2], 'a markdown table is drawn as a table');
  await board.evaluate(() => deck.events([
    { at: Date.now() / 1000 - 4000, id: 'y2', state: 'yours', title: 'Empire game with Catan aesthetic', proj: 'harvestcrown', text: 'Four tickets are running' },
    { at: Date.now() / 1000 - 300, id: 'd1', state: 'done', title: 'UX-8', proj: 'harvestcrown', text: 'All replay checks pass' },
    { at: Date.now() / 1000 - 90, id: 'b1', state: 'blocked', title: 'Payments refactor', proj: 'vivaa', text: 'permission request' },
  ]));
  assert.deepEqual(await board.evaluate(() => [...document.querySelectorAll('#feed .event')].map((e) => e.classList.contains('old'))), [false, false, true], 'newest first; what you had already seen is dimmed');
  if (shots) await board.screenshot({ path: shots + '/board-talk.png' });
  await board.click('#feed .event.old');
  assert.equal(await sel(board), 'y2', 'a click in the feed selects that agent');
  await board.evaluate(() => document.getElementById('row-y1').click());
  await msgs(board);
  await board.click('#tabs [data-tab="changes"]');
  assert.deepEqual((await msgs(board, 'changes')).map((m) => m.id), ['y1']);
  await board.evaluate(() => deck.changes('y1', { branch: 'main...origin/main [ahead 2]', more: 0, commits: ['a1b2c3d Add the harbour level'],
    files: [{ code: ' M', path: 'src/boat.js' }, { code: '??', path: 'notes/a -> b.md' }, { code: 'R ', path: 'new.js' }] }));
  assert.ok((await board.textContent('#commitList')).includes('Add the harbour level'), 'commits made since the last prompt are listed');
  await board.click('#changedList .file:nth-of-type(1)');
  assert.deepEqual(await msgs(board, 'diff'), [{ cmd: 'diff', id: 'y1', file: 'src/boat.js', untracked: false }]);
  await board.evaluate(() => deck.diff('y1', 'src/boat.js', 'diff --git a/src/boat.js b/src/boat.js\n@@ -1,2 +1,2 @@\n-const speed = 4;\n+const speed = 6;\n <script>alert(1)</script>'));
  assert.deepEqual(await board.evaluate(() => [document.querySelectorAll('#diff .add').length, document.querySelectorAll('#diff .del').length, document.querySelectorAll('#diff script').length]), [1, 1, 0]);
  await board.click('#changedList .file:nth-of-type(2)');
  assert.deepEqual(await msgs(board, 'diff'), [{ cmd: 'diff', id: 'y1', file: 'notes/a -> b.md', untracked: true }], 'a file name is passed on exactly as git reported it');
  await board.evaluate(() => document.getElementById('row-y2').click());
  assert.ok(!(await board.textContent('#diff')).includes('speed'), 'another agent never shows the previous agent\'s diff');
  await board.evaluate(() => document.getElementById('row-y1').click());
  if (shots) { await board.click('#changedList .file:nth-of-type(1)'); await board.evaluate(() => deck.diff('y1', 'src/boat.js', 'diff --git a/src/boat.js b/src/boat.js\n@@ -1,2 +1,2 @@\n-const speed = 4;\n+const speed = 6;\n const hull = 100;')); await board.screenshot({ path: shots + '/board-changes.png' }); }
  await msgs(board);
  await board.click('#tabs [data-tab="term"]');
  assert.deepEqual((await msgs(board, 'screen')).map((m) => m.id), ['y1']);
  await board.keyboard.press('Escape');
  assert.deepEqual(await msgs(board, 'hide'), [], 'escape does not close a window');
  await board.keyboard.press('Shift+Meta+d');
  assert.deepEqual(await msgs(board, 'board'), [{ cmd: 'board', on: false }]);
  assert.deepEqual(board.errors, []);

  await browser.close();
  console.log('ok', browser.browserType().name());
})().catch((e) => { console.error(e); process.exit(1); });
