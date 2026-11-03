import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_ENV = 'DESKTOP_CHAT_STATE';
const MAX_INPUT = 12000;
const MAX_PAGE = 8000;

export class StateError extends Error {
  constructor(code, message) { super(message); this.name = 'StateError'; this.code = code; }
}

const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const nonempty = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new StateError('invalid_input', `${name} must be a nonempty string`);
  return v.trim();
};
const defaultPath = () => process.env[STATE_ENV] || path.join(os.homedir(), '.codex', 'state', 'desktop-chat');

async function locked(fn) {
  const dir = defaultPath();
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'state.lock');
  try { await fs.mkdir(lock); }
  catch (e) { if (e.code === 'EEXIST') throw new StateError('busy_lock', 'State is locked by another operation'); throw e; }
  try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({pid:process.pid,started_at:new Date().toISOString()})); return await fn(dir); }
  finally { await fs.unlink(path.join(lock,'owner.json')).catch(() => {}); await fs.rmdir(lock).catch(() => {}); }
}

async function readState(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, binding: null, jobs: {} }; throw new StateError('state_corrupt', `Cannot read state: ${e.message}`); }
}
async function writeState(dir, state) {
  const target = path.join(dir, 'state.json');
  const tmp = path.join(dir, `.state-${randomUUID()}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(tmp, target);
}
const active = job => job && !job.closed_at;
function unpackSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StateError('invalid_snapshot', 'snapshot must be an object');
  if (input.isError === true || input.success === false) throw new StateError('invalid_snapshot', 'Native read failed; cannot treat error as an observation');
  let body = input.structuredContent?.thread ? input.structuredContent : input;
  if (Array.isArray(input.content)) {
    const texts = input.content.filter(x => x?.type === 'text' && typeof x.text === 'string');
    for (const part of texts) {
      try { const parsed = JSON.parse(part.text); if (parsed && typeof parsed === 'object') { body = parsed; break; } }
      catch { /* not a JSON body */ }
    }
  }
  const thread = body.thread ?? body;
  if (thread.kind !== 'chatgpt') throw new StateError('wrong_chat_kind', 'Only thread.kind=chatgpt is supported');
  const id = thread.id;
  const title = thread.title;
  if (typeof id !== 'string' || !id || typeof title !== 'string') throw new StateError('invalid_snapshot', 'snapshot must include thread id and title');
  const status = typeof thread.status === 'object' ? thread.status?.type : thread.status;
  return { id, title, status, body };
}
function isIdle(status) { return status === 'idle'; }
function getJob(state, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) throw new StateError('invalid_input', 'Invalid work_unit_id');
  return Object.hasOwn(state.jobs, id) ? state.jobs[id] : undefined;
}
function makePrompt(id, hash, payload) {
  return `[DESKTOP_CHAT_TASK:${id}:${hash}]\n\nGoal:\n${payload.goal}\n\nContext:\n${payload.context || '(none)'}\n\nAcceptance:\n${payload.acceptance || '(none)'}\n\nAuthorization:\n${payload.authorization}\n\nSource references:\n${payload.source_refs || '(none)'}\n\n请用中文完成任务，答复不超过 6000 个中文字符，不执行任何外部操作。请在回复末尾独立一行写出以下标记：\n[DESKTOP_CHAT_DONE:${id}:${hash}]`;
}

export async function status() {
  return locked(async dir => {
    const s = await readState(dir);
    const jobs = Object.values(s.jobs);
    const brief = j => j ? {work_unit_id:j.work_unit_id,state:j.state,binding:j.binding,send_attempted:j.send_attempted,closed_at:j.closed_at??null,disposition:j.disposition??null,actual_model:'unknown',attention_reason:j.attention_reason??null,response_sha256:j.response_sha256??null} : null;
    return { binding: s.binding, active_job: brief(jobs.find(active)), jobs: jobs.slice(-20).map(brief), total_jobs:jobs.length, state_path: dir };
  });
}

export async function bind({ snapshot, authorization, selected_model } = {}) {
  return locked(async dir => {
    const s = await readState(dir), target = unpackSnapshot(snapshot);
    if (!isIdle(target.status)) throw new StateError('chat_busy', 'Target chat must be idle');
    const auth = nonempty(authorization, 'authorization');
    if (Object.values(s.jobs).some(active)) throw new StateError('active_job', 'Cannot change binding while a job is open');
    s.binding = { chat_id: target.id, title: target.title, authorization: auth, selected_model: typeof selected_model === 'string' ? selected_model : null, actual_model: 'unknown', bound_at: new Date().toISOString() };
    await writeState(dir, s);
    return { binding: s.binding };
  });
}

export async function prepare(input = {}) {
  return locked(async dir => {
    const s = await readState(dir);
    const id = nonempty(input.work_unit_id, 'work_unit_id');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) throw new StateError('invalid_input', 'work_unit_id has invalid format');
    if (Object.keys(input).some(k => !['work_unit_id','goal','context','acceptance','authorization','source_refs'].includes(k))) throw new StateError('invalid_input', 'Unsupported prepare field');
    const refs = input.source_refs ?? [];
    if (!Array.isArray(refs) || !refs.every(x => typeof x === 'string')) throw new StateError('invalid_input', 'source_refs must be a string array');
    for (const k of ['context','acceptance']) if (input[k] !== undefined && typeof input[k] !== 'string') throw new StateError('invalid_input', `${k} must be text`);
    const payload = { goal: nonempty(input.goal, 'goal'), context: input.context ?? '', acceptance: input.acceptance ?? '', authorization: nonempty(input.authorization, 'authorization'), source_refs: refs };
    if (json({ ...payload, work_unit_id: id }).length > MAX_INPUT) throw new StateError('input_too_large', `Input exceeds ${MAX_INPUT} characters`);
    if (!s.binding) throw new StateError('not_bound', 'No chat is bound');
    const canonical = json(payload), existing = getJob(s, id);
    if (existing) {
      if (existing.input_hash !== sha(canonical)) throw new StateError('conflict', 'work_unit_id already exists with different input');
      return { job: existing, idempotent: true };
    }
    if (Object.values(s.jobs).some(active)) throw new StateError('active_job', 'Only one open job is allowed globally');
    const hash = sha(canonical), prompt = makePrompt(id, hash, payload);
    const job = { work_unit_id: id, state: 'prepared', binding: { chat_id: s.binding.chat_id, title: s.binding.title }, actual_model: 'unknown', input_hash: hash, prompt, created_at: new Date().toISOString(), send_attempted: false, response_sha256: null };
    s.jobs[id] = job;
    await writeState(dir, s);
    return { job, idempotent: false };
  });
}

export async function begin({ work_unit_id, snapshot } = {}) {
  return locked(async dir => {
    const s = await readState(dir), job = getJob(s, work_unit_id);
    if (!job) throw new StateError('not_found', 'Job not found');
    if (job.closed_at || job.state !== 'prepared') return { job, unknown_submission: job.send_attempted, needs_reconcile: job.send_attempted, native_action: null };
    const target = unpackSnapshot(snapshot);
    if (target.id !== job.binding.chat_id) throw new StateError('wrong_chat', 'Snapshot is not from the bound chat');
    if (!isIdle(target.status)) throw new StateError('chat_busy', 'Target chat must be idle');
    job.state = 'dispatching'; job.send_attempted = true; job.dispatch_intent_at = new Date().toISOString();
    await writeState(dir, s);
    return { job, native_action: { tool: 'mcp__codex_app__send_message_to_thread', arguments: { threadId: job.binding.chat_id, prompt: job.prompt } }, note: 'This action has not been sent by the ledger.' };
  });
}

function extractTurns(body) { return Array.isArray(body.turns) ? body.turns : Array.isArray(body.messages) ? body.messages : []; }
function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(x => typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '').join('');
  if (value && typeof value === 'object') return typeof value.text === 'string' ? value.text : '';
  return '';
}
function truncated(x) { return Boolean(x?.truncated || x?.isTruncated || x?.is_truncated || (Array.isArray(x?.content) && x.content.some(truncated))); }
function turnUser(t) {
  const item = t.items?.find(x => x.type === 'userMessage');
  return item ? { text: textOf(item.content), truncated: truncated(item) } : t.userMessage ?? t.user_message ?? t.user ?? null;
}
function turnAssistant(t) {
  const items = t.items?.filter(x => x.type === 'agentMessage' && typeof x.text === 'string' && x.text.trim());
  return items?.length ? {id:items.at(-1).id,text:items.map(x=>x.text).join('\n\n'),truncated:items.some(truncated),message_ids:items.map(x=>x.id??null)} : t.agentMessage ?? t.agent_message ?? t.assistantMessage ?? t.assistant_message ?? t.assistant ?? null;
}
function systemError(t) { return Boolean(t?.systemError || t?.system_error || t?.error); }

export async function observe({ work_unit_id, snapshot } = {}) {
  return locked(async dir => {
    const s = await readState(dir), job = getJob(s, work_unit_id);
    if (!job) throw new StateError('not_found', 'Job not found');
    if (job.closed_at) throw new StateError('closed', 'Closed jobs cannot be observed');
    if (!job.send_attempted) throw new StateError('not_dispatched', 'Job has no send intent');
    const target = unpackSnapshot(snapshot);
    if (target.id !== job.binding.chat_id) throw new StateError('wrong_chat', 'Snapshot is not from the job target');
    if (job.state === 'completed') return { job, state: job.state };
    const turns = extractTurns(target.body);
    if (target.status === 'systemError' || !['active','idle'].includes(target.status)) { job.state = 'needs_attention'; job.attention_reason = `thread status: ${target.status ?? 'unknown'}`; await writeState(dir, s); return { job, state: job.state }; }
    if (target.status === 'active') { job.state = 'running'; await writeState(dir, s); return { job, state: job.state }; }
    let matches = [];
    for (const turn of turns) {
      const user = turnUser(turn), userText = textOf(user);
      if (userText.includes(`[DESKTOP_CHAT_TASK:${work_unit_id}:`) || (userText === job.prompt && truncated(user))) {
        if (truncated(user)) { job.state = 'needs_attention'; job.attention_reason = 'matched user message is truncated'; await writeState(dir, s); return { job, state: job.state }; }
        if (userText === job.prompt) matches.push(turn);
      }
    }
    if (matches.length !== 1) { job.state = matches.length ? 'needs_attention' : 'unknown_submission'; job.attention_reason = matches.length ? 'multiple matching turns' : null; await writeState(dir, s); return { job, state: job.state, unknown_submission: true }; }
    const turn = matches[0], assistant = turnAssistant(turn), response = textOf(assistant);
    if (truncated(assistant)) { job.state = 'needs_attention'; job.attention_reason = 'assistant response is truncated'; await writeState(dir, s); return { job, state: job.state }; }
    if (systemError(turn)) { job.state = 'needs_attention'; job.attention_reason = 'matched turn has systemError'; await writeState(dir, s); return { job, state: job.state }; }
    if (!response.trim()) { job.state = 'needs_attention'; job.attention_reason = 'Idle chat has no nonempty assistant response for the task'; await writeState(dir, s); return { job, state: job.state }; }
    const expected = `[DESKTOP_CHAT_DONE:${work_unit_id}:${job.input_hash}]`;
    if (response.trimEnd().split(/\r?\n/).at(-1) !== expected) { job.state = 'needs_attention'; job.attention_reason = 'assistant response lacks the required independent final marker'; await writeState(dir, s); return { job, state: job.state }; }
    job.state = 'completed'; job.response_sha256 = sha(response); job.response_file = `responses/${work_unit_id}.md`; job.response_saved_at = new Date().toISOString(); job.root_review = 'pending_root_review';
    job.completion_evidence = {source:'desktop_read_thread',thread_status:target.status,turn_id:turn.id??null,message_id:assistant?.id??null,message_ids:assistant?.message_ids??[],exact_prompt_match:true,independent_done_marker:true,response_truncated:false,response_chars:response.length,actual_model:'unknown'};
    await fs.mkdir(path.join(dir, 'responses'), { recursive: true });
    const dest = path.join(dir, job.response_file);
    try { await fs.writeFile(dest, response, { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; const prior = await fs.readFile(dest, 'utf8'); if (sha(prior) !== job.response_sha256) throw new StateError('response_conflict', 'Existing response file differs'); }
    await writeState(dir, s);
    return { job, state: job.state };
  });
}

export async function result({ work_unit_id, offset = 0, limit = MAX_PAGE } = {}) {
  return locked(async dir => {
    const s = await readState(dir), job = getJob(s, work_unit_id);
    if (!job) throw new StateError('not_found', 'Job not found');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw new StateError('invalid_input', 'offset/limit invalid');
    if (job.state !== 'completed') throw new StateError('not_completed', 'Job has no completed result');
    const content = await fs.readFile(path.join(dir, job.response_file), 'utf8');
    if (sha(content) !== job.response_sha256) throw new StateError('hash_mismatch', 'Saved response hash does not match ledger');
    const size = Math.min(limit, MAX_PAGE), page = content.slice(offset, offset + size);
    return { work_unit_id, actual_model: 'unknown', response_path: path.join(dir, job.response_file), sha256: job.response_sha256, content: page, offset, total_length: content.length, truncated: offset + page.length < content.length, summary: content.slice(0, 1500), summary_truncated: content.length > 1500 };
  });
}

export async function close({ work_unit_id, disposition, reason } = {}) {
  return locked(async dir => {
    const s = await readState(dir), job = getJob(s, work_unit_id);
    if (!job) throw new StateError('not_found', 'Job not found');
    if (!['accepted', 'rejected', 'abandoned'].includes(disposition)) throw new StateError('invalid_input', 'Invalid disposition');
    if (disposition === 'accepted' && job.state !== 'completed') throw new StateError('not_completed', 'Only completed jobs can be accepted');
    if (job.closed_at) {
      if (job.disposition !== disposition || job.close_reason !== nonempty(reason, 'reason')) throw new StateError('close_conflict', 'Job already closed with a different decision');
      if (job.root_review !== (disposition === 'accepted' ? 'accepted_by_root' : disposition)) { job.root_review = disposition === 'accepted' ? 'accepted_by_root' : disposition; await writeState(dir, s); }
      return {job, note:'Local decision already recorded; no remote action was performed.'};
    }
    job.closed_at = new Date().toISOString(); job.disposition = disposition; job.close_reason = nonempty(reason, 'reason'); job.root_review = disposition === 'accepted' ? 'accepted_by_root' : disposition;
    await writeState(dir, s);
    return { job, note: 'Closing the local ledger does not stop remote work.' };
  });
}

export const methods = { status, bind, prepare, begin, observe, result, close };
