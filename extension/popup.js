const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);

async function current() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function draw() {
  const s = await ask({ type: 'status' });
  const tab = await current();
  $('dot').className = 'dot' + (s.connected ? ' on' : '');
  $('state').textContent = !s.enabled ? 'Switched off' : s.connected ? 'Connected to agentweb' : 'Waiting for agentweb on this computer…';
  $('port').value = s.port;
  $('waiting').hidden = !s.waiting;
  $('waiting').textContent = s.waiting ? 'The agent is waiting for you: ' + s.waiting : '';
  $('stop').hidden = !s.enabled;
  $('start').hidden = s.enabled;
  const box = $('tabs');
  box.textContent = '';
  if (s.tabs.length) {
    const p = document.createElement('div');
    p.textContent = 'An agent is using:';
    const ul = document.createElement('ul');
    for (const t of s.tabs) {
      const li = document.createElement('li');
      li.textContent = t.title || 'a tab';
      ul.append(li);
    }
    box.append(p, ul);
  }
  const shared = tab && s.offered.includes(tab.id);
  const inUse = tab && s.tabs.some((t) => t.tabId === tab.id);
  $('share').hidden = !tab || inUse || !s.enabled;
  $('share').textContent = shared ? 'Stop sharing this tab' : 'Share this tab with the agent';
  $('share').onclick = async () => {
    await ask({ type: 'share', tabId: tab.id, on: !shared });
    draw();
  };
}

$('stop').onclick = async () => {
  await ask({ type: 'stop' });
  draw();
};
$('start').onclick = async () => {
  await ask({ type: 'settings', port: $('port').value, enabled: true });
  setTimeout(draw, 600);
};
$('save').onclick = async () => {
  const s = await ask({ type: 'status' });
  await ask({ type: 'settings', port: $('port').value, enabled: s.enabled });
  setTimeout(draw, 600);
};
draw();
setInterval(draw, 1500);
