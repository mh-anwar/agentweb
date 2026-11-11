import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the actual launcher and cleanup without calling a model or starting a browser.
// Baseline packages are optional and installed separately from the main project.
test('baseline launcher pins its binary, isolates explicit sessions, cleans them up, and rejects a non-executable binary', {
  skip: !existsSync(new URL('../bench/baselines/node_modules/agent-browser/package.json', import.meta.url)),
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-launch-test-'));
  const log = join(dir, 'calls.jsonl');
  const native = join(dir, 'pinned');
  const agent = join(dir, 'agent.mjs');
  const oldAgent = process.env.AW_BASELINE_CLAUDE;
  writeFileSync(native, `#!/usr/bin/env node
const {appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
const i=args.indexOf('--session');
const session=i>=0?args[i+1]:args.find(a=>a.startsWith('--session='))?.slice(10)??process.env.AGENT_BROWSER_SESSION;
appendFileSync(${JSON.stringify(log)},JSON.stringify({args,session})+'\\n');
console.log('pinned-browser');
`, { mode: 0o755 });
  writeFileSync(agent, `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
for(const args of [['open','http://example.test'],['--session','custom','open','http://example.test'],['--session=other','open','http://example.test']]){
 const r=spawnSync('agent-browser',args,{encoding:'utf8'});
 if(r.status!==0||!r.stdout.includes('pinned-browser'))throw new Error('wrong binary or failed launch: '+r.stderr);
}
console.log(JSON.stringify({type:'result',subtype:'success',result:'ok',num_turns:1,usage:{},total_cost_usd:0}));
`, { mode: 0o755 });
  process.env.AW_BASELINE_CLAUDE = agent;
  const { BIN } = await import('../bench/baselines/tools.ts');
  const oldBinary = BIN.agentBrowser;
  BIN.agentBrowser = native;
  try {
    const { runAgentTask } = await import('../bench/baselines/run-agent.ts');
    const r = await runAgentTask({ tool: 'agent-browser', prompt: 'test', outDir: dir });
    assert.equal(r.answer, 'ok');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const opened = calls.filter(c => c.args.includes('open')).map(c => c.session);
    const closed = calls.filter(c => c.args.includes('close')).map(c => c.session);
    assert.equal(new Set(opened).size, 3);
    assert.ok(opened.every(s => /^aw-[a-f0-9]+(?:-|$)/.test(s)), 'all sessions must be scoped to this run');
    assert.deepEqual(new Set(closed), new Set(opened), 'all model-created sessions must be closed');
    chmodSync(native, 0o644);
    await assert.rejects(runAgentTask({ tool: 'agent-browser', prompt: 'must not launch', outDir: dir }), { code: 'EACCES' });
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, calls.length, 'no fallback process should run');
  } finally {
    BIN.agentBrowser = oldBinary;
    if (oldAgent === undefined) delete process.env.AW_BASELINE_CLAUDE;
    else process.env.AW_BASELINE_CLAUDE = oldAgent;
    rmSync(dir, { recursive: true, force: true });
  }
});
