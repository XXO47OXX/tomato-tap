// test_codex_compat.mjs — offline sanity tests for the chat ↔ codex round-trip.
// Run: node test_codex_compat.mjs

import { chatCompletionsToCodexRequest, codexSSEToChatCompletion } from '../src/providers/adapters/codex_compat.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

console.log('--- chatCompletionsToCodexRequest ---');

// 1. Basic system + user → codex with instructions + 1 user input
{
  const req = Buffer.from(JSON.stringify({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user',   content: 'reply pong' },
    ],
    temperature: 0.2,
    max_tokens: 50,
  }));
  const out = chatCompletionsToCodexRequest(req);
  check('basic.model',          out.model === 'gpt-5.4');
  check('basic.instructions',   out.instructions === 'You are a helpful assistant.');
  check('basic.store_false',    out.store === false);
  check('basic.stream_true',    out.stream === true);
  // Codex backend rejects max_output_tokens/temperature/top_p — they should NOT appear.
  check('basic.no_temp',        !('temperature' in out));
  check('basic.no_max_output',  !('max_output_tokens' in out));
  check('basic.no_top_p',       !('top_p' in out));
  check('basic.input_count',    out.input.length === 1, `got ${out.input.length}`);
  check('basic.input_role',     out.input[0].role === 'user');
  check('basic.input_type',     out.input[0].content[0].type === 'input_text');
  check('basic.input_text',     out.input[0].content[0].text === 'reply pong');
}

// 2. No system message → falls back to default instructions
{
  const req = Buffer.from(JSON.stringify({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'hi' }],
  }));
  const out = chatCompletionsToCodexRequest(req);
  check('no_sys.has_default_instructions', typeof out.instructions === 'string' && out.instructions.length > 0);
}

// 3. Multiple systems joined; user/assistant interleave
{
  const req = Buffer.from(JSON.stringify({
    model: 'gpt-5.4-mini',
    messages: [
      { role: 'system',    content: 'rule1' },
      { role: 'system',    content: 'rule2' },
      { role: 'user',      content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user',      content: 'q2' },
    ],
  }));
  const out = chatCompletionsToCodexRequest(req);
  check('multi_sys.joined',     out.instructions === 'rule1\n\nrule2');
  check('multi_sys.three_input', out.input.length === 3);
  check('multi_sys.asst_kind',  out.input[1].role === 'assistant');
  check('multi_sys.asst_part',  out.input[1].content[0].type === 'output_text');
}

// 4. Unknown model name → default gpt-5.4
{
  const out = chatCompletionsToCodexRequest(Buffer.from(JSON.stringify({
    model: 'gpt-4o-2024-09',
    messages: [{ role: 'user', content: 'x' }],
  })));
  check('unknown_model.fallback', out.model === 'gpt-5.4');
}

// 4b. Codex alias resolves to upstream model
{
  const out = chatCompletionsToCodexRequest(Buffer.from(JSON.stringify({
    model: 'gpt-5.4-codex',
    messages: [{ role: 'user', content: 'x' }],
  })));
  check('alias.codex_resolves', out.model === 'gpt-5.4');
}

// 5. Empty messages → at least one placeholder user input
{
  const out = chatCompletionsToCodexRequest(Buffer.from(JSON.stringify({
    model: 'gpt-5.4',
    messages: [],
  })));
  check('empty.input_min_1', out.input.length >= 1);
}

// 6. Invalid body → null
{
  const out = chatCompletionsToCodexRequest(Buffer.from('not json'));
  check('invalid.null', out === null);
}

// 7. Multimodal content array (image+text) → text only kept
{
  const out = chatCompletionsToCodexRequest(Buffer.from(JSON.stringify({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,XXX' } },
    ] }],
  })));
  check('mm.text_only', out.input[0].content[0].text === 'describe this');
}

console.log('\n--- codexSSEToChatCompletion ---');

// 8. Happy path: created → text deltas → completed with usage
{
  const sse = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_abc","model":"gpt-5.4"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"po"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ng"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_abc","status":"completed","usage":{"input_tokens":12,"output_tokens":2}}}',
    '',
  ].join('\n');
  const r = codexSSEToChatCompletion(Buffer.from(sse), 'gpt-5.4');
  check('happy.ok',          r.ok === true);
  check('happy.id',          r.response.id === 'resp_abc');
  check('happy.model',       r.response.model === 'gpt-5.4');
  check('happy.content',     r.response.choices[0].message.content === 'pong');
  check('happy.role',        r.response.choices[0].message.role === 'assistant');
  check('happy.finish_stop', r.response.choices[0].finish_reason === 'stop');
  check('happy.in_tok',      r.response.usage.prompt_tokens === 12);
  check('happy.out_tok',     r.response.usage.completion_tokens === 2);
  check('happy.tot_tok',     r.response.usage.total_tokens === 14);
}

// 9. response.failed → ok=false
{
  const sse = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_x"}}',
    '',
    'event: response.failed',
    'data: {"type":"response.failed","response":{"id":"resp_x","status":"failed","error":{"code":"foo","message":"bar"}}}',
    '',
  ].join('\n');
  const r = codexSSEToChatCompletion(Buffer.from(sse), 'gpt-5.4');
  check('failed.ok_false', r.ok === false);
  check('failed.has_err',  r.error && typeof r.error === 'object');
}

// 10. Incomplete with max_output_tokens → finish_reason='length'
{
  const sse = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"trunc"}',
    '',
    'event: response.incomplete',
    'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
    '',
  ].join('\n');
  const r = codexSSEToChatCompletion(Buffer.from(sse), 'gpt-5.4');
  check('incomplete.length', r.response.choices[0].finish_reason === 'length');
}

// 11. Reasoning deltas accumulated to reasoning_content
{
  const sse = [
    'event: response.reasoning_summary_text.delta',
    'data: {"type":"response.reasoning_summary_text.delta","delta":"step1"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"answer"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"status":"completed"}}',
    '',
  ].join('\n');
  const r = codexSSEToChatCompletion(Buffer.from(sse), 'gpt-5.4');
  check('reasoning.text',      r.response.choices[0].message.content === 'answer');
  check('reasoning.preserved', r.response.choices[0].message.reasoning_content === 'step1');
}

// 11b. SSE parse failure warn is throttled (log-spaced 1,2,4,8,...)
{
  const mod = await import('../src/providers/adapters/codex_compat.mjs');
  mod._resetSSEParseFailCountForTest();
  // Capture console.warn calls
  const origWarn = console.warn;
  let warnCount = 0;
  console.warn = () => { warnCount++; };
  try {
    // Build SSE with 20 malformed events
    const badEvent = 'event: response.output_text.delta\ndata: {{{not json\n\n';
    const sse = badEvent.repeat(20);
    codexSSEToChatCompletion(Buffer.from(sse), 'gpt-5.4');
  } finally {
    console.warn = origWarn;
  }
  check('sse_throttle.count_total',    mod._sseParseFailCountForTest() === 20);
  // Expect warns at 1,2,4,8,16 → 5 warns
  check('sse_throttle.warn_log_spaced', warnCount === 5,
    `expected 5 warns (1+2+4+8+16=count<=20), got ${warnCount}`);
}

// 12. Round-trip: chat request → codex body → simulated upstream → chat response
{
  const chatReq = Buffer.from(JSON.stringify({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'You are a brand-recognition assistant.' },
      { role: 'user',   content: 'is "cisco" a brand?' },
    ],
  }));
  const codex = chatCompletionsToCodexRequest(chatReq);
  // emulate upstream: just confirm shape, then build a mock SSE response
  const sse = [
    'event: response.created',
    `data: {"type":"response.created","response":{"id":"resp_rt","model":"${codex.model}"}}`,
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"yes"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":15,"output_tokens":1}}}',
    '',
  ].join('\n');
  const chat = codexSSEToChatCompletion(Buffer.from(sse), codex.model);
  check('round_trip.ok',          chat.ok === true);
  check('round_trip.content',     chat.response.choices[0].message.content === 'yes');
  check('round_trip.model_match', chat.response.model === 'gpt-5.4');
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
