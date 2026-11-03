import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as core from '../src/core.mjs';
import { handleRpc, dispatch, runStdio } from '../src/server.mjs';
import { Readable, Writable } from 'node:stream';

let root, state;
const snap = (status = 'idle', turns = [], id = 'chat-A') => ({ schemaVersion: 1, thread: { kind: 'chatgpt', id, title: 'Dedicated Chat', status: { type: status } }, turns });
const textMsg = (text, extra = {}) => ({ text, ...extra });
const call = (method, data) => core[method](data);
async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), 'desktop-chat-')); state = path.join(root, 'ledger'); process.env.DESKTOP_CHAT_STATE = state;
  await call('bind', { snapshot: snap(), authorization: 'user authorized test' });
}
async function prepared(id = 'work-1', payload = {}) {
  return (await call('prepare', { work_unit_id: id, goal: 'Review the bounded sample', acceptance: 'Return evidence', authorization: 'authorized', ...payload })).job;
}
async function dispatched(id = 'work-1') {
  const job = await prepared(id); const result = await call('begin', { work_unit_id: id, snapshot: snap() }); return { job, result };
}
function completedSnapshot(job, response = `Reviewed.\n[DESKTOP_CHAT_DONE:${job.work_unit_id}:${job.input_hash}]`, opts = {}) {
  return snap('idle', [{ id: 'user-1', status: 'completed', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: job.prompt, ...(opts.user || {}) }] }, { type: 'agentMessage', id: 'assistant-1', text: response, ...(opts.assistant || {}) }], ...(opts.turn || {}) }]);
}
test.afterEach(async () => { delete process.env.DESKTOP_CHAT_STATE; if (root) await rm(root, { recursive: true, force: true }); });

test('bind rejects wrong or busy chat; bind records model as declaration only', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'desktop-chat-')); state = path.join(root, 'ledger'); process.env.DESKTOP_CHAT_STATE = state;
  const wrong = snap(); wrong.thread.kind = 'codex';
  await assert.rejects(call('bind', { snapshot: wrong, authorization: 'ok' }), { code: 'wrong_chat_kind' });
  await assert.rejects(call('bind', { snapshot: snap('running'), authorization: 'ok' }), { code: 'chat_busy' });
  const r = await call('bind', { snapshot: snap(), authorization: 'ok', selected_model: 'ChatGPT Pro' });
  assert.equal(r.binding.selected_model, 'ChatGPT Pro'); assert.equal(r.binding.actual_model, 'unknown');
});

test('prepare is idempotent for same input and conflicts for changed payload', async () => {
  await setup(); const a = await prepared(); const b = await prepared();
  assert.equal(b.input_hash, a.input_hash);
  await assert.rejects(prepared('work-1', { goal: 'different' }), { code: 'conflict' });
});

test('global one-open-job limit and input validation', async () => {
  await setup(); await prepared('one');
  await assert.rejects(prepared('two'), { code: 'active_job' });
  await assert.rejects(prepared('bad id'), { code: 'invalid_input' });
});

test('begin checks target and busy state, returns one action only; repeated call never resends', async () => {
  await setup(); await prepared();
  await assert.rejects(call('begin', { work_unit_id: 'work-1', snapshot: snap('idle', [], 'elsewhere') }), { code: 'wrong_chat' });
  await assert.rejects(call('begin', { work_unit_id: 'work-1', snapshot: snap('running') }), { code: 'chat_busy' });
  const first = await call('begin', { work_unit_id: 'work-1', snapshot: snap() }); assert.ok(first.native_action);
  const second = await call('begin', { work_unit_id: 'work-1', snapshot: snap() }); assert.equal(second.native_action, null); assert.equal(second.unknown_submission, true);
});

test('wrong observation chat leaves job unchanged', async () => {
  await setup(); await dispatched();
  await assert.rejects(call('observe', { work_unit_id: 'work-1', snapshot: snap('idle', [], 'other') }), { code: 'wrong_chat' });
  assert.equal((await call('status', {})).active_job.state, 'dispatching');
});

test('old unrelated turns cannot be mistaken for this job', async () => {
  await setup(); const { job } = await dispatched();
  const r = await call('observe', { work_unit_id: job.work_unit_id, snapshot: snap('idle', [{ userMessage: textMsg('old request'), agentMessage: textMsg(`[DESKTOP_CHAT_DONE:${job.work_unit_id}:${job.input_hash}]`) }]) });
  assert.equal(r.state, 'unknown_submission');
});

test('user and assistant truncation require attention; system error and missing marker do too', async () => {
  await setup(); const { job } = await dispatched();
  let r = await call('observe', { work_unit_id: job.work_unit_id, snapshot: completedSnapshot(job, undefined, { user: { truncated: true } }) }); assert.equal(r.state, 'needs_attention');
  await setup(); const second = await dispatched('truncated-assistant');
  r = await call('observe', { work_unit_id: second.job.work_unit_id, snapshot: completedSnapshot(second.job, undefined, { assistant: { truncated: true } }) }); assert.equal(r.state, 'needs_attention');
  await setup(); const third = await dispatched('missing-marker');
  r = await call('observe', { work_unit_id: third.job.work_unit_id, snapshot: completedSnapshot(third.job, 'answer') }); assert.equal(r.state, 'needs_attention');
  await setup(); const fourth = await dispatched('error-turn');
  r = await call('observe', { work_unit_id: fourth.job.work_unit_id, snapshot: completedSnapshot(fourth.job, undefined, { turn: { systemError: true } }) }); assert.equal(r.state, 'needs_attention');
});

test('completed response is saved, paged with hash, and tampering is detected', async () => {
  await setup(); const { job } = await dispatched();
  const longResponse = `${'evidence '.repeat(250)}\n[DESKTOP_CHAT_DONE:${job.work_unit_id}:${job.input_hash}]`;
  const result = await call('observe', { work_unit_id: job.work_unit_id, snapshot: completedSnapshot(job, longResponse) }); assert.equal(result.state, 'completed');
  const page = await call('result', { work_unit_id: job.work_unit_id, limit: 5 }); assert.equal(page.sha256, result.job.response_sha256); assert.equal(page.truncated, true); assert.equal(page.summary_truncated, true); assert.equal(page.summary.length, 1500);
  await writeFile(path.join(state, result.job.response_file), 'tampered');
  await assert.rejects(call('result', { work_unit_id: job.work_unit_id }), { code: 'hash_mismatch' });
});

test('MCP envelope snapshot is decoded; close rules and abandoned jobs cannot be resent', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'desktop-chat-')); state = path.join(root, 'ledger'); process.env.DESKTOP_CHAT_STATE = state;
  const envelope = { content: [{ type: 'text', text: JSON.stringify(snap()) }] };
  await call('bind', { snapshot: envelope, authorization: 'authorized' }); const { job } = await dispatched();
  await assert.rejects(call('close', { work_unit_id: job.work_unit_id, disposition: 'accepted', reason: 'done' }), { code: 'not_completed' });
  await call('close', { work_unit_id: job.work_unit_id, disposition: 'abandoned', reason: 'manual' });
  const repeat = await call('begin', { work_unit_id: job.work_unit_id, snapshot: snap() }); assert.equal(repeat.native_action, null);
  await assert.rejects(call('observe', { work_unit_id: job.work_unit_id, snapshot: snap() }), { code: 'closed' });
});

test('global mkdir lock rejects concurrent state access and releases after error', async () => {
  await setup(); await mkdir(path.join(state, 'state.lock'));
  await assert.rejects(call('status', {}), { code: 'busy_lock' }); await rm(path.join(state, 'state.lock'), { recursive: true });
  assert.ok((await call('status', {})).binding);
});

test('MCP tool schemas stay open for snapshots and CLI emits one JSON result', async () => {
  await setup();
  const listed = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const bindTool = listed.result.tools.find(x => x.name === 'desktop_chat_bind'); assert.equal(bindTool.inputSchema.properties.snapshot.additionalProperties, true);
  const pong = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'ping' }); assert.deepEqual(pong.result, {});
  assert.ok(await dispatch('desktop_chat_status', {}));
  const server = path.resolve('src/server.mjs'); const child = spawn(process.execPath, [server, 'status'], { env: { ...process.env, DESKTOP_CHAT_STATE: state }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', b => stdout += b); await once(child, 'close');
  assert.equal(JSON.parse(stdout).binding.chat_id, 'chat-A');
});

test('native thread status gates completion, and completed jobs never regress', async () => {
  await setup(); const { job } = await dispatched();
  const input = completedSnapshot(job);
  input.thread.status.type = 'active';
  assert.equal((await call('observe', { work_unit_id: job.work_unit_id, snapshot: input })).state, 'running');
  input.thread.status.type = 'systemError';
  assert.equal((await call('observe', { work_unit_id: job.work_unit_id, snapshot: input })).state, 'needs_attention');
  input.thread.status.type = 'idle';
  assert.equal((await call('observe', { work_unit_id: job.work_unit_id, snapshot: input })).state, 'completed');
  assert.equal((await call('observe', { work_unit_id: job.work_unit_id, snapshot: snap('active') })).state, 'completed');
});

test('duplicate prompt and non-independent footer cannot produce completion', async () => {
  await setup(); const { job } = await dispatched();
  const duplicate = completedSnapshot(job); duplicate.turns.push(duplicate.turns[0]);
  assert.equal((await call('observe', { work_unit_id: job.work_unit_id, snapshot: duplicate })).state, 'needs_attention');
  const inline = completedSnapshot(job, `answer [DESKTOP_CHAT_DONE:${job.work_unit_id}:${job.input_hash}]`);
  assert.equal((await call('observe', { work_unit_id: job.work_unit_id, snapshot: inline })).state, 'needs_attention');
});

test('prototype property names are valid isolated work IDs, not inherited jobs', async () => {
  await setup(); const job = await prepared('constructor', { source_refs: ['local-reference-only'] });
  assert.equal(job.work_unit_id, 'constructor');
  assert.equal((await call('begin', { work_unit_id: 'constructor', snapshot: snap() })).native_action.arguments.threadId, 'chat-A');
});

test('malformed RPC and notifications cannot kill service or mutate binding', async () => {
  await setup(); let output = '';
  const input = Readable.from(['null\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":null}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n']);
  const target = new Writable({ write(chunk, enc, done) { output += chunk.toString(); done(); } });
  await runStdio(input, target);
  const rows = output.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3); assert.equal(rows[0].error.code, -32600); assert.equal(rows[1].error.code, -32600); assert.deepEqual(rows[2].result, {});
  assert.equal(await handleRpc({ jsonrpc:'2.0', method:'tools/call', params:{ name:'desktop_chat_bind', arguments:{snapshot:snap('idle',[],'other'),authorization:'should not run'} } }), null);
  assert.equal((await call('status',{})).binding.chat_id, 'chat-A');
  await assert.rejects(dispatch('prepare',{work_unit_id:'x',goal:'g',authorization:'a',extra:true}), {code:'invalid_input'});
});

test('a stale empty read may reconcile later without another send action', async () => {
  await setup(); const {job} = await dispatched();
  assert.equal((await call('observe',{work_unit_id:job.work_unit_id,snapshot:snap()})).state,'unknown_submission');
  assert.equal((await call('begin',{work_unit_id:job.work_unit_id,snapshot:snap()})).native_action,null);
  const accepted = await call('observe',{work_unit_id:job.work_unit_id,snapshot:completedSnapshot(job)});
  assert.equal(accepted.state,'completed');
  assert.equal(accepted.job.completion_evidence.exact_prompt_match,true);
  assert.equal(accepted.job.completion_evidence.response_truncated,false);
  const decision = {work_unit_id:job.work_unit_id,disposition:'accepted',reason:'root verified'};
  assert.equal((await call('close',decision)).job.root_review,'accepted_by_root');
  assert.equal((await call('close',decision)).job.root_review,'accepted_by_root');
  await assert.rejects(call('close',{...decision,disposition:'rejected'}),{code:'close_conflict'});
});

test('multiple assistant items are preserved and truncation in an earlier item blocks completion', async () => {
  await setup(); const {job} = await dispatched();
  const observation=completedSnapshot(job);
  observation.turns[0].items.splice(1,0,{type:'agentMessage',id:'part-one',text:'First answer segment',truncated:true});
  assert.equal((await call('observe',{work_unit_id:job.work_unit_id,snapshot:observation})).state,'needs_attention');
  delete observation.turns[0].items[1].truncated;
  assert.equal((await call('observe',{work_unit_id:job.work_unit_id,snapshot:observation})).state,'completed');
  const saved=await call('result',{work_unit_id:job.work_unit_id});
  assert.ok(saved.content.startsWith('First answer segment\n\nReviewed.'));
});
