import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { methods, StateError } from './core.mjs';

const schemas = {
  status: { type: 'object', properties: {}, additionalProperties: false },
  bind: { type: 'object', properties: { snapshot: { type: 'object', additionalProperties: true }, authorization: { type: 'string' }, selected_model: { type: 'string' } }, required: ['snapshot', 'authorization'], additionalProperties: false },
  prepare: { type: 'object', properties: { work_unit_id: { type: 'string' }, goal: { type: 'string' }, context: { type: 'string' }, acceptance: { type: 'string' }, authorization: { type: 'string' }, source_refs: { type: 'array', items: { type: 'string' } } }, required: ['work_unit_id', 'goal', 'authorization'], additionalProperties: false },
  begin: { type: 'object', properties: { work_unit_id: { type: 'string' }, snapshot: { type: 'object', additionalProperties: true } }, required: ['work_unit_id', 'snapshot'], additionalProperties: false },
  observe: { type: 'object', properties: { work_unit_id: { type: 'string' }, snapshot: { type: 'object', additionalProperties: true } }, required: ['work_unit_id', 'snapshot'], additionalProperties: false },
  result: { type: 'object', properties: { work_unit_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8000 } }, required: ['work_unit_id'], additionalProperties: false },
  close: { type: 'object', properties: { work_unit_id: { type: 'string' }, disposition: { type: 'string', enum: ['accepted', 'rejected', 'abandoned'] }, reason: { type: 'string' } }, required: ['work_unit_id', 'disposition', 'reason'], additionalProperties: false },
};

export async function dispatch(method, params = {}) {
  if (typeof method !== 'string' || !params || typeof params !== 'object' || Array.isArray(params)) throw new StateError('invalid_input', 'Method and arguments must be valid');
  const prefix = 'desktop_chat_';
  const name = method.startsWith(prefix) ? method.slice(prefix.length) : method;
  if (!Object.hasOwn(methods, name)) throw new StateError('method_not_found', `Unknown method: ${method}`);
  const schema = schemas[name];
  for (const key of Object.keys(params)) if (!Object.hasOwn(schema.properties, key)) throw new StateError('invalid_input', `Unexpected field: ${key}`);
  for (const key of schema.required ?? []) if (!Object.hasOwn(params, key)) throw new StateError('invalid_input', `Missing field: ${key}`);
  for (const [key, value] of Object.entries(params)) {
    const rule = schema.properties[key];
    const valid = rule.type === 'integer' ? Number.isSafeInteger(value) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity) : rule.type === 'array' ? Array.isArray(value) && value.every(x => typeof x === 'string') : rule.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === rule.type;
    if (!valid || (rule.enum && !rule.enum.includes(value))) throw new StateError('invalid_input', `Invalid field: ${key}`);
  }
  return methods[name](params);
}

export async function handleRpc(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))) return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  if (!Object.hasOwn(message, 'id')) return null;
  const { id, method, params = {} } = message;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'desktop-chat-ledger', version: '0.1.0' } } };
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: Object.keys(schemas).map(name => ({ name: `desktop_chat_${name}`, description: name === 'begin' ? 'Persist send intent and return native_action exactly once. DOES NOT SEND. Coordinator invokes the public desktop tool; uncertain sends must only be observed, never retried.' : `Local desktop chat ledger: ${name}. Does not invoke native Chat; actual model is unknown.`, inputSchema: schemas[name] })) } };
  if (method === 'tools/call') {
    try {
      const result = await dispatch(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } };
    } catch (e) {
      const error = { code: e.code || 'internal_error', message: e.message };
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(error) }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function cli(argv) {
  const [command, ...rest] = argv;
  if (!command || !Object.hasOwn(methods, command)) throw new StateError('usage', 'Usage: server.mjs <status|bind|prepare|begin|observe|result|close> [--input file|--json JSON]');
  if (rest.length !== 0 && rest.length !== 2) throw new StateError('usage','Provide exactly one --input file or --json JSON argument pair');
  let input = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--input' && rest[i + 1]) { const { readFile } = await import('node:fs/promises'); input = JSON.parse(await readFile(rest[++i], 'utf8')); }
    else if (rest[i] === '--json' && rest[i + 1]) input = JSON.parse(rest[++i]);
    else throw new StateError('usage', `Unexpected argument: ${rest[i]}`);
  }
  process.stdout.write(`${JSON.stringify(await dispatch(command, input))}\n`);
}

export async function runStdio(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); continue; }
    const reply = await handleRpc(msg);
    if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  try {
    if (process.argv.includes('--stdio')) await runStdio();
    else await cli(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: { code: e.code || 'error', message: e.message } })}\n`);
    process.exitCode = 1;
  }
}
