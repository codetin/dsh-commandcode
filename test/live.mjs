/**
 * Manual live check against the real Command Code gateway.
 *
 * Run `pnpm live` (or `node test/live.mjs`) with a key available either in
 * `COMMANDCODE_API_KEY` or in `~/.dsh/.credentials.yaml` (under `refs:` or the
 * legacy top level). It prints the streamed answer and the reported usage and
 * reports whether the request used `/alpha/generate` (never the 403-prone
 * Provider API).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CommandCodeAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_REQUEST_IMAGE_BYTES, DEFAULT_MAX_TOKENS } from '../lib/adapter.js'
import { fetchUsage } from '../lib/usage.js'
import { fetchCliVersion } from '../lib/version.js'

function apiKey() {
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY.trim()
  const filename = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  const text = fs.readFileSync(filename, 'utf8')
  const nested = text.match(/^\s{2,}COMMANDCODE_API_KEY:\s*(\S+)\s*$/m)
  const flat = text.match(/^COMMANDCODE_API_KEY:\s*(\S+)\s*$/m)
  const value = nested?.[1] ?? flat?.[1]
  if (value === undefined) throw new Error(`no COMMANDCODE_API_KEY in ${filename}`)
  return value
}

const model = process.argv[2] ?? 'deepseek/deepseek-v4-flash'
const cliVersion = (await fetchCliVersion()) ?? '1.88.2'
const adapter = new CommandCodeAdapter({
  connection: () => ({
    displayName: 'Command Code',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    baseURL: 'https://api.commandcode.ai',
    plan: 'go',
    maxTokens: DEFAULT_MAX_TOKENS,
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    http1: false,
    cliVersion,
  }),
  models: () => [],
  resolveApiKey: async () => apiKey(),
  resolveAttachments: () => undefined,
})

console.log(`model=${model} cliVersion=${cliVersion} endpoint=/alpha/generate`)
let answer = ''
for await (const chunk of adapter.stream({
  provider: 'commandcode',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: pong' }] }],
})) {
  if (chunk.type === 'text-delta') {
    answer += chunk.text
    process.stdout.write(chunk.text)
  } else if (chunk.type === 'reasoning-delta') {
    process.stdout.write(`\u001b[2m${chunk.text}\u001b[0m`)
  } else if (chunk.type === 'usage') {
    console.log('\nusage:', JSON.stringify(chunk.usage))
  } else if (chunk.type === 'finish') {
    console.log('finish:', JSON.stringify(chunk.reason))
  }
}
if (answer.trim() !== 'pong') throw new Error(`unexpected answer: ${JSON.stringify(answer)}`)

// The same read-only billing routes the composer status bar consumes.
try {
  const snapshot = await fetchUsage({ apiKey: apiKey(), cliVersion })
  const share = value => (typeof value === 'number' ? `${Math.round(value)}%` : '—')
  console.log('quota:', `5h ${share(snapshot.windows.fiveHour?.percent)}`,
    `weekly ${share(snapshot.windows.weekly?.percent)}`,
    `monthly ${share(snapshot.monthly?.percent)}`,
    snapshot.plan === undefined ? '' : `plan=${snapshot.plan.name}`)
} catch (error) {
  console.log('quota: unavailable —', error instanceof Error ? error.message : String(error))
}

console.log('\nlive check passed')
