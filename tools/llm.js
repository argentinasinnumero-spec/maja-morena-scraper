'use strict';
const OpenAI = require('openai');

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Llama a OpenAI y devuelve JSON parseado.
 * @param {object} opts
 * @param {string} opts.system      - System prompt
 * @param {string} opts.user        - User message
 * @param {'flash'|'pro'} opts.model - 'flash' = gpt-4o-mini, 'pro' = gpt-4o
 * @param {number} opts.temperature
 * @returns {Promise<object>}
 */
async function ask({ system, user, model = 'flash', temperature = 0.3 }) {
  const modelName = model === 'pro' ? 'gpt-4o' : 'gpt-4o-mini';
  const resp = await getClient().chat.completions.create({
    model:           modelName,
    temperature,
    max_tokens:      2500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user   },
    ],
  });
  return JSON.parse(resp.choices[0].message.content);
}

module.exports = { ask };
