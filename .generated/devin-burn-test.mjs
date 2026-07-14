const baseUrl = process.env.SUNTA_BASE_URL || 'https://sunta-api.up.railway.app/v1';
const apiKey = process.env.SUNTA_API_KEY;
const targetTokens = Number(process.env.BURN_TARGET_TOKENS || 5_000_000);
const maxAttempts = Number(process.env.BURN_MAX_ATTEMPTS || 80);
const maxTokensPerRequest = Number(process.env.BURN_MAX_TOKENS || 200_000);

if (!apiKey) {
  console.error('SUNTA_API_KEY is required');
  process.exit(1);
}

function makePrompt(attempt) {
  return `You are running a completion stress test. Generate as much visible output as possible until the max token limit stops you.\n\nRules:\n- Do not use tools.\n- Do not summarize.\n- Do not stop early.\n- Write continuous numbered Indonesian prose paragraphs.\n- Each paragraph should be unique enough to avoid repetition filters.\n- Start at paragraph ${attempt * 100000 + 1}.\n- Continue until the server stops generation.`;
}

async function runAttempt(attempt) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'devin/swe-1-6-slow',
      stream: true,
      max_tokens: maxTokensPerRequest,
      messages: [{ role: 'user', content: makePrompt(attempt) }],
    }),
  });

  const result = {
    attempt: attempt + 1,
    status: response.status,
    latencyMs: 0,
    contentChars: 0,
    reasoningChars: 0,
    sseBytes: 0,
    events: 0,
    finishReasons: [],
    usage: null,
    error: null,
  };

  if (!response.ok || !response.body) {
    const text = await response.text();
    result.latencyMs = Date.now() - started;
    try {
      const json = JSON.parse(text);
      result.error = json.error ?? json;
    } catch {
      result.error = text.slice(0, 500);
    }
    return result;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function handle(payload) {
    if (!payload || payload === '[DONE]') return;
    result.events += 1;
    let json;
    try { json = JSON.parse(payload); } catch { return; }
    if (json.error) {
      result.error = json.error;
      return;
    }
    if (json.usage) result.usage = json.usage;
    for (const choice of json.choices ?? []) {
      if (choice.delta?.content) result.contentChars += choice.delta.content.length;
      if (choice.delta?.reasoning_content) result.reasoningChars += choice.delta.reasoning_content.length;
      if (choice.finish_reason) result.finishReasons.push(choice.finish_reason);
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result.sseBytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split('\n')) {
        if (line.startsWith('data: ')) handle(line.slice(6));
      }
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data: ')) handle(line.slice(6));
    }
  }
  result.latencyMs = Date.now() - started;
  return result;
}

const results = [];
const summary = {
  requests: 0,
  successes: 0,
  sseBytes: 0,
  contentChars: 0,
  reasoningChars: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedOutputTokens: 0,
};

for (let i = 0; i < maxAttempts && summary.totalTokens < targetTokens; i += 1) {
  const result = await runAttempt(i);
  results.push(result);
  summary.requests += 1;
  if (result.status === 200 && !result.error) summary.successes += 1;
  summary.sseBytes += result.sseBytes;
  summary.contentChars += result.contentChars;
  summary.reasoningChars += result.reasoningChars;
  summary.promptTokens += result.usage?.prompt_tokens ?? 0;
  summary.completionTokens += result.usage?.completion_tokens ?? 0;
  summary.totalTokens += result.usage?.total_tokens ?? 0;
  summary.estimatedOutputTokens += Math.ceil((result.contentChars + result.reasoningChars) / 4);
  const usageTotal = result.usage?.total_tokens ?? 'n/a';
  const estimated = Math.ceil((result.contentChars + result.reasoningChars) / 4);
  console.log(JSON.stringify({
    attempt: result.attempt,
    status: result.status,
    latencyMs: result.latencyMs,
    usageTotal,
    completionTokens: result.usage?.completion_tokens ?? null,
    estimatedOutputTokens: estimated,
    contentChars: result.contentChars,
    reasoningChars: result.reasoningChars,
    finishReasons: result.finishReasons,
    runningTotalTokens: summary.totalTokens,
    error: result.error ? { code: result.error.code, type: result.error.type, message: String(result.error.message ?? result.error).slice(0, 220) } : null,
  }));
  if (result.status === 429 || result.status >= 500 || result.error) break;
}

console.log('SUMMARY ' + JSON.stringify({ summary, lastResult: results.at(-1) }));
