const TOPICS = ['react', 'typescript', 'python', 'testing', 'review', 'design', 'security', 'git', 'api'];

function overlapTopics(skills) {
  return TOPICS.map((topic) => ({
    topic,
    count: skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(topic)).length,
  })).filter(({ count }) => count >= 2).sort((a, b) => b.count - a.count);
}

export function roastFacts(report) {
  return {
    provider: report.provider,
    installedSkills: report.loadedSkills.length,
    skillFilesOnDisk: report.skills.length,
    installedPlugins: report.plugins.length,
    estimatedActivationTokens: report.loadedCatalogTokens,
    removableRepeatedBodyTokens: report.duplicateTokens,
    tokenEstimateMethod: report.tokenEstimateMethod,
    marketplaceSkillsNotActive: report.marketplaceSkills.length,
    overlapTopics: overlapTopics(report.loadedSkills),
  };
}

export async function generateRoast(report, {
  tone = 'brutal',
  model = process.env.SKILLRAM_MODEL,
  llm,
  anthropicApiKey = process.env.ANTHROPIC_API_KEY,
  openaiApiKey = process.env.OPENAI_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const validTones = new Set(['brutal', 'professional', 'hacker']);
  if (!validTones.has(tone)) throw new Error(`Unknown tone “${tone}”. Use brutal, professional, or hacker.`);
  if (typeof fetchImpl !== 'function') throw new Error('roast requires Node.js 18 or newer with fetch support.');
  const backend = llm ?? (anthropicApiKey ? 'anthropic' : openaiApiKey ? 'openai' : null);
  if (!backend) throw new Error('roast requires ANTHROPIC_API_KEY or OPENAI_API_KEY. Only aggregate metrics are sent.');
  if (!['anthropic', 'openai'].includes(backend)) throw new Error('LLM provider must be anthropic or openai.');
  if (backend === 'anthropic' && !anthropicApiKey) throw new Error('--llm anthropic requires ANTHROPIC_API_KEY.');
  if (backend === 'openai' && !openaiApiKey) throw new Error('--llm openai requires OPENAI_API_KEY.');

  const facts = roastFacts(report);
  const instructions = `Write a short ${tone} roast of a coding-agent skill catalog. Use only the supplied JSON facts. Never invent a number, cost, overlap, token saving, or claim that an inactive marketplace skill is loaded. Token counts are estimates. If overlapTopics is empty or repeated tokens are zero, acknowledge that honestly instead of pretending there is bloat. Use correct singular/plural grammar. Return only the roast in plain text, no heading or markdown fence.`;
  const request = backend === 'anthropic' ? {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: model ?? 'claude-haiku-4-5',
      max_tokens: 220,
      temperature: 0.8,
      system: instructions,
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    },
  } : {
    url: 'https://api.openai.com/v1/responses',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${openaiApiKey}`,
    },
    body: {
      model: model ?? 'gpt-5.6-luna',
      instructions,
      input: JSON.stringify(facts),
      max_output_tokens: 220,
    },
  };
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => {
    throw new Error(`${backend} roast request failed: ${error.message}`);
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${backend} roast request failed (${response.status}): ${payload.error?.message ?? 'unknown API error'}`);
  const text = backend === 'anthropic'
    ? payload.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
    : (payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === 'output_text').map((item) => item.text).join('\n'))?.trim();
  if (!text) throw new Error(`${backend === 'anthropic' ? 'Anthropic' : 'OpenAI'} returned an empty roast.`);
  return text;
}
