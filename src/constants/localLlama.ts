/**
 * Local Llama.cpp configuration
 * 
 * This module provides configuration for using a local llama.cpp instance
 * instead of any external models (Anthropic, OpenAI, etc.)
 */

export const ENV_LLMAMA_HOST = 'LLAMA_CPP_SERVER'
export const ENV_LLMAMA_PORT = 'LLAMA_PORT'
export const ENV_LLMAMA_MODEL = 'LLAMA_CPP_MODEL'
export const ENV_LLMAMA_API_KEY = 'LLAMA_API_KEY'
export const ENV_LLMAMA_TIMEOUT_MS = 'LLAMA_TIMEOUT_MS'
export const ENV_LLAMA_MODE = 'LOUKANIKODE_USE_LLAMA'

export const DEFAULT_LLAMA_CONFIG = {
  host: 'localhost',
  port: 8080,
  timeoutMs: 300000,
}

function isEnvTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

function parseServerUrl(): { host: string; port: number; baseUrl: string } {
  const server = process.env[ENV_LLMAMA_HOST]
  if (!server) {
    return {
      host: DEFAULT_LLAMA_CONFIG.host,
      port: DEFAULT_LLAMA_CONFIG.port,
      baseUrl: `http://${DEFAULT_LLAMA_CONFIG.host}:${DEFAULT_LLAMA_CONFIG.port}`,
    }
  }

  if (server.startsWith('http://') || server.startsWith('https://')) {
    try {
      const url = new URL(server)
      const port = url.port
        ? parseInt(url.port, 10)
        : url.protocol === 'https:'
          ? 443
          : 80
      return {
        host: url.hostname,
        port,
        baseUrl: `${url.protocol}//${url.host}`,
      }
    } catch { }
  }

  const parts = server.split(':')
  const host = parts[0]
  const portPart = parts[1]?.split('/')[0]
  const port = portPart ? parseInt(portPart, 10) : DEFAULT_LLAMA_CONFIG.port
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
  }
}

export function getLlamaHost(): string {
  return parseServerUrl().host
}

export function getLlamaPort(): number {
  const portStr = process.env[ENV_LLMAMA_PORT]
  return portStr ? parseInt(portStr, 10) : parseServerUrl().port
}

export function getLlamaModel(): string {
  const model = process.env[ENV_LLMAMA_MODEL]
  if (model) return model
  
  const server = process.env[ENV_LLMAMA_HOST]
  if (server) {
    try {
      const url = new URL(server)
      const parts = url.pathname.split('/')
      if (parts.length > 0) {
        const lastPart = parts[parts.length - 1]
        if (lastPart && (lastPart.endsWith('.gguf') || lastPart.includes('-Q'))) {
          return lastPart
        }
      }
    } catch { }
  }
  return 'local-llama'
}

export function getLlamaApiKey(): string | undefined {
  return process.env[ENV_LLMAMA_API_KEY]
}

export function getLlamaTimeoutMs(): number {
  const timeoutStr = process.env[ENV_LLMAMA_TIMEOUT_MS]
  return timeoutStr ? parseInt(timeoutStr, 10) : DEFAULT_LLAMA_CONFIG.timeoutMs
}

export function isLlamaModeEnabled(): boolean {
  if (isEnvTruthy(process.env[ENV_LLAMA_MODE])) {
    return true
  }
  
  const hasExternalProvider = 
    process.env.ANTHROPIC_API_KEY ||
    process.env.LOUKANIKODE_USE_BEDROCK ||
    process.env.LOUKANIKODE_USE_VERTEX ||
    process.env.LOUKANIKODE_USE_FOUNDRY ||
    process.env.LOUKANIKODE_USE_OPENAI
  
  return !hasExternalProvider
}

export function getLlamaBaseUrl(): string {
  return parseServerUrl().baseUrl
}

export function getLlamaCompletionsUrl(): string {
  return `${getLlamaBaseUrl()}/v1/chat/completions`
}

export function getLlamaEmbeddingsUrl(): string {
  return `${getLlamaBaseUrl()}/v1/embeddings`
}
