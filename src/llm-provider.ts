export type LlmProtocol =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'gemini-generate-content'

export interface LlmEnvironment {
  [name: string]: string | undefined
  OPENAI_API_KEY?: string
  OPENROUTER_API_KEY?: string
  FREEMODEL_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  GEMINI_API_KEY?: string
  LLM_API_KEY?: string
  OPENAI_API_ORG?: string
}

export interface LlmConnection {
  apiKey: string
  apiBaseUrl: string
  protocol: LlmProtocol
  apiOrg?: string
}

const defaultBaseUrls: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  freemodel: 'https://freemodel.in/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta'
}

const defaultProtocols: Record<string, LlmProtocol> = {
  openai: 'openai-responses',
  openrouter: 'openai-responses',
  freemodel: 'openai-chat-completions',
  anthropic: 'anthropic-messages',
  gemini: 'gemini-generate-content',
  'openai-compatible': 'openai-chat-completions'
}

const protocols = new Set<LlmProtocol>([
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
  'gemini-generate-content'
])

function safeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

/** Resolves a provider preset and an independently selectable wire protocol. */
export function resolveLlmConnection(
  provider: string,
  environment: LlmEnvironment,
  baseUrl = '',
  requestedProtocol = 'auto'
): LlmConnection {
  const defaults = defaultProtocols[provider]
  if (!defaults) throw new Error('Unsupported LLM provider')
  if (
    requestedProtocol !== 'auto' &&
    !protocols.has(requestedProtocol as LlmProtocol)
  ) {
    throw new Error('Unsupported LLM API protocol')
  }

  const protocol =
    requestedProtocol === 'auto' ? defaults : (requestedProtocol as LlmProtocol)
  const defaultBaseUrl = defaultBaseUrls[provider]
  if (provider === 'openrouter' && baseUrl && baseUrl !== defaultBaseUrl) {
    throw new Error(
      'OpenRouter uses a fixed endpoint; remove base URL override'
    )
  }
  const apiBaseUrl =
    provider === 'openai-compatible'
      ? baseUrl.trim()
      : baseUrl.trim() || defaultBaseUrl
  if (!apiBaseUrl)
    throw new Error('OpenAI-compatible provider requires a base URL')
  if (!safeBaseUrl(apiBaseUrl))
    throw new Error('Unsafe or invalid LLM API base URL')

  const keyName: Record<string, keyof LlmEnvironment> = {
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    freemodel: 'FREEMODEL_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    'openai-compatible': 'LLM_API_KEY'
  }
  const providerKey = environment[keyName[provider]]?.trim()
  const apiKey =
    provider === 'freemodel'
      ? providerKey || environment.LLM_API_KEY?.trim()
      : providerKey
  if (!apiKey) throw new Error(`Missing ${provider} provider credentials`)

  return {
    apiKey,
    apiBaseUrl,
    protocol,
    ...(provider === 'openai' && environment.OPENAI_API_ORG
      ? {apiOrg: environment.OPENAI_API_ORG}
      : {})
  }
}
