/**
 * Explicit provider configuration is the only place where credentials are
 * selected. OpenRouter uses a pinned HTTPS origin so a misconfigured custom
 * OpenAI-compatible URL cannot receive its key.
 */
export interface LlmEnvironment {
  OPENAI_API_KEY?: string
  OPENROUTER_API_KEY?: string
  OPENAI_API_ORG?: string
}

export interface LlmConnection {
  apiKey: string
  apiBaseUrl: string
  apiOrg?: string
}

export function resolveLlmConnection(
  provider: string,
  environment: LlmEnvironment,
  openaiBaseUrl = 'https://api.openai.com/v1'
): LlmConnection {
  if (provider === 'openai') {
    const key = environment.OPENAI_API_KEY?.trim()
    if (!key) throw new Error('Missing OpenAI provider credentials')
    return {
      apiKey: key,
      apiBaseUrl: openaiBaseUrl,
      ...(environment.OPENAI_API_ORG ? {apiOrg: environment.OPENAI_API_ORG} : {})
    }
  }
  if (provider === 'openrouter') {
    if (openaiBaseUrl !== 'https://api.openai.com/v1') {
      throw new Error('OpenRouter uses a fixed endpoint; remove openai_base_url override')
    }
    const key = environment.OPENROUTER_API_KEY?.trim()
    if (!key) throw new Error('Missing OpenRouter provider credentials')
    return {apiKey: key, apiBaseUrl: 'https://openrouter.ai/api/v1'}
  }
  throw new Error('Unsupported LLM provider')
}
