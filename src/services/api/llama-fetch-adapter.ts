/**
 * Llama.cpp Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to a local
 * llama.cpp server's OpenAI-compatible /v1/chat/completions endpoint,
 * translating between Anthropic Messages API format and OpenAI Chat
 * Completions format.
 *
 * Supports:
 * - Text messages (user/assistant)
 * - System prompts
 * - Tool definitions (Anthropic input_schema → OpenAI parameters)
 * - Tool use / tool results
 * - Streaming (OpenAI SSE → Anthropic SSE)
 * - Non-streaming (OpenAI JSON → Anthropic JSON)
 * - Thinking/reasoning blocks
 */

import {
  getLlamaModel,
  getLlamaApiKey,
  getLlamaTimeoutMs,
  getLlamaCompletionsUrl,
} from '../../constants/localLlama.js'

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  thinking?: string
  signature?: string
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

// ── Tool translation: Anthropic → OpenAI ─────────────────────────────

function translateTools(anthropicTools: AnthropicTool[]): Array<{
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}> {
  return anthropicTools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

// ── Message translation: Anthropic → OpenAI ──────────────────────────

function translateMessages(
  anthropicMessages: AnthropicMessage[],
  systemPrompt: string | Array<{ type: string; text?: string; cache_control?: unknown }> | undefined,
): OpenAIMessage[] {
  const openaiMessages: OpenAIMessage[] = []

  if (systemPrompt) {
    const sysText = typeof systemPrompt === 'string'
      ? systemPrompt
      : Array.isArray(systemPrompt)
        ? systemPrompt
            .filter(b => b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text!)
            .join('\n')
        : ''
    if (sysText) {
      openaiMessages.push({ role: 'system', content: sysText })
    }
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      openaiMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const textParts: string[] = []
      const toolResults: OpenAIMessage[] = []

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map(c => {
                if (c.type === 'text') return c.text || ''
                if (c.type === 'image') return '[Image]'
                return ''
              })
              .join('\n')
          }
          toolResults.push({
            role: 'tool',
            content: outputText,
            tool_call_id: block.tool_use_id || 'unknown',
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        }
      }

      if (textParts.length > 0) {
        openaiMessages.push({ role: 'user', content: textParts.join('\n') })
      }
      openaiMessages.push(...toolResults)
    } else if (msg.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: OpenAIToolCall[] = []
      let thinkingText = ''

      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input || {}),
            },
          })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          thinkingText += block.thinking
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('\n') || null,
      }

      if (thinkingText && !toolCalls.length) {
        assistantMsg.content = assistantMsg.content
          ? `<think/>\n${thinkingText}\n</think/>\n\n${assistantMsg.content}`
          : `<think/>\n${thinkingText}\n</think/>`
      }

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
        if (!textParts.length) {
          assistantMsg.content = null
        }
      }

      openaiMessages.push(assistantMsg)
    }
  }

  return openaiMessages
}

// ── Full request translation ────────────────────────────────────────

function translateToOpenAI(anthropicBody: Record<string, unknown>): {
  openaiBody: Record<string, unknown>
  model: string
  isStreaming: boolean
} {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined
  const claudeModel = anthropicBody.model as string
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]
  const isStreaming = anthropicBody.stream === true

  const model = getLlamaModel() || claudeModel || 'local-llama'
  const messages = translateMessages(anthropicMessages, systemPrompt)

  const openaiBody: Record<string, unknown> = {
    model,
    messages,
  }

  if (isStreaming) {
    openaiBody.stream = true
  }

  if (anthropicTools.length > 0) {
    openaiBody.tools = translateTools(anthropicTools)
  }

  if (typeof anthropicBody.max_tokens === 'number') {
    openaiBody.max_tokens = anthropicBody.max_tokens
  }

  if (typeof anthropicBody.temperature === 'number') {
    openaiBody.temperature = anthropicBody.temperature
  }

  if (Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length > 0) {
    openaiBody.stop = anthropicBody.stop_sequences
  }

  return { openaiBody, model, isStreaming }
}

// ── Finish reason mapping ───────────────────────────────────────────

function mapFinishReason(openaiReason: string | null | undefined): string {
  switch (openaiReason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

// ── Non-streaming response translation ──────────────────────────────

function translateOpenAIResponseToAnthropic(
  openaiJson: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const messageId = `msg_llama_${Date.now()}`
  const choices = openaiJson.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  const message = choice?.message as Record<string, unknown> | undefined
  const usage = openaiJson.usage as Record<string, number> | undefined

  const content: AnthropicContentBlock[] = []

  const reasoningContent = message?.reasoning_content as string | undefined
  const textContent = message?.content as string | null | undefined

  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
    content.push({ type: 'thinking', thinking: reasoningContent })
  }

  if (typeof textContent === 'string' && textContent.length > 0) {
    content.push({ type: 'text', text: textContent })
  }

  const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const tcFunction = tc.function as Record<string, unknown> | undefined
      let input: Record<string, unknown> = {}
      try {
        const args = tcFunction?.arguments as string
        if (args) input = JSON.parse(args)
      } catch {
        input = {}
      }
      content.push({
        type: 'tool_use',
        id: (tc.id as string) || `call_${Date.now()}`,
        name: (tcFunction?.name as string) || '',
        input,
      })
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const finishReason = mapFinishReason(choice?.finish_reason as string | null)

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: finishReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  }
}

// ── SSE formatting helpers ──────────────────────────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

// ── Streaming response translation ──────────────────────────────────

async function translateOpenAIStreamToAnthropic(
  openaiResponse: Response,
  model: string,
): Promise<Response> {
  const messageId = `msg_llama_${Date.now()}`

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let outputTokens = 0
      let inputTokens = 0
      let lastFinishReason: string | null = null

      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_start',
            JSON.stringify({
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }),
          ),
        ),
      )

      controller.enqueue(
        encoder.encode(formatSSE('ping', JSON.stringify({ type: 'ping' }))),
      )

      let currentTextBlockStarted = false
      let inToolCall = false
      let hadToolCalls = false
      let inThinkingBlock = false

      function closeTextBlock() {
        if (currentTextBlockStarted) {
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_stop', JSON.stringify({
                type: 'content_block_stop',
                index: contentBlockIndex,
              })),
            ),
          )
          contentBlockIndex++
          currentTextBlockStarted = false
        }
      }

      function closeThinkingBlock() {
        if (inThinkingBlock) {
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_stop', JSON.stringify({
                type: 'content_block_stop',
                index: contentBlockIndex,
              })),
            ),
          )
          contentBlockIndex++
          inThinkingBlock = false
        }
      }

      function closeToolCallBlock() {
        if (inToolCall) {
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_stop', JSON.stringify({
                type: 'content_block_stop',
                index: contentBlockIndex,
              })),
            ),
          )
          contentBlockIndex++
          inToolCall = false
        }
      }

      try {
        const reader = openaiResponse.body?.getReader()
        if (!reader) {
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_start', JSON.stringify({
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              })),
            ),
          )
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_delta', JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: 'Error: No response body from llama server' },
              })),
            ),
          )
          closeTextBlock()
          finishStream(controller, encoder, outputTokens, inputTokens, 'end_turn')
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let toolCallIndex = 0
        const toolCallArgsMap = new Map<number, string>()
        const toolCallIdMap = new Map<number, string>()
        const toolCallNameMap = new Map<number, string>()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            if (!trimmed.startsWith('data: ')) {
              console.error('[llama-fetch-adapter] Unexpected line:', trimmed.slice(0, 100))
              continue
            }

            const dataStr = trimmed.slice(6)
            if (dataStr === '[DONE]') continue

            let chunk: Record<string, unknown>
            try {
              chunk = JSON.parse(dataStr)
            } catch {
              console.error('[llama-fetch-adapter] Failed to parse SSE data:', dataStr.slice(0, 100))
              continue
            }

            const choices = chunk.choices as Array<Record<string, unknown>> | undefined
            if (!choices || choices.length === 0) continue

            const choice = choices[0]!
            const delta = (choice.delta as Record<string, unknown> | undefined) ?? {}
            const chunkFinishReason = choice.finish_reason as string | null
            if (chunkFinishReason) {
              lastFinishReason = chunkFinishReason
            }

            const reasoningContent = delta.reasoning_content as string | undefined
            if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
              if (!inThinkingBlock) {
                closeTextBlock()
                controller.enqueue(
                  encoder.encode(
                    formatSSE('content_block_start', JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: { type: 'thinking', thinking: '' },
                    })),
                  ),
                )
                inThinkingBlock = true
              }
              controller.enqueue(
                encoder.encode(
                  formatSSE('content_block_delta', JSON.stringify({
                    type: 'content_block_delta',
                    index: contentBlockIndex,
                    delta: { type: 'thinking_delta', thinking: reasoningContent },
                  })),
                ),
              )
              outputTokens += 1
            }

            const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined
            if (toolCalls && toolCalls.length > 0) {
              for (const tc of toolCalls) {
                const tcIndex = (tc.index as number) ?? toolCallIndex
                const tcFunction = tc.function as Record<string, unknown> | undefined

                if (tc.id) {
                  closeTextBlock()
                  closeThinkingBlock()

                  const callId = tc.id as string
                  const funcName = (tcFunction?.name as string) || ''
                  toolCallIdMap.set(tcIndex, callId)
                  toolCallNameMap.set(tcIndex, funcName)
                  toolCallArgsMap.set(tcIndex, '')
                  hadToolCalls = true

                  if (inToolCall) {
                    closeToolCallBlock()
                  }

                  inToolCall = true

                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_start', JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: {
                          type: 'tool_use',
                          id: callId,
                          name: funcName,
                          input: {},
                        },
                      })),
                    ),
                  )
                }

                if (tcFunction && typeof tcFunction.arguments === 'string') {
                  const argDelta = tcFunction.arguments
                  toolCallArgsMap.set(tcIndex, (toolCallArgsMap.get(tcIndex) || '') + argDelta)

                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_delta', JSON.stringify({
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: {
                          type: 'input_json_delta',
                          partial_json: argDelta,
                        },
                      })),
                    ),
                  )
                }

                toolCallIndex++
              }
            }

            const content = (delta.content ?? choice.text) as string | undefined | null
            const hasContent = content !== null && typeof content === 'string' && content.length > 0

            if (hasContent && !inToolCall) {
              if (inThinkingBlock) {
                closeThinkingBlock()
              }
              if (!currentTextBlockStarted) {
                controller.enqueue(
                  encoder.encode(
                    formatSSE('content_block_start', JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: { type: 'text', text: '' },
                    })),
                  ),
                )
                currentTextBlockStarted = true
              }
              controller.enqueue(
                encoder.encode(
                  formatSSE('content_block_delta', JSON.stringify({
                    type: 'content_block_delta',
                    index: contentBlockIndex,
                    delta: { type: 'text_delta', text: content },
                  })),
                ),
              )
              outputTokens += 1
            }

            const usage = chunk.usage as Record<string, number> | undefined
            if (usage) {
              outputTokens = usage.completion_tokens || usage.total_tokens || outputTokens
              inputTokens = usage.prompt_tokens || inputTokens
            }
          }
        }
      } catch (err) {
        if (!currentTextBlockStarted && !inToolCall && !inThinkingBlock) {
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_start', JSON.stringify({
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              })),
            ),
          )
          currentTextBlockStarted = true
        }
        controller.enqueue(
          encoder.encode(
            formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: `\n\n[Error: ${String(err)}]` },
            })),
          ),
        )
      }

      closeTextBlock()
      closeThinkingBlock()
      closeToolCallBlock()

      const stopReason = mapFinishReason(lastFinishReason ?? (hadToolCalls ? 'tool_calls' : null))
      finishStream(controller, encoder, outputTokens, inputTokens, stopReason)
    },
  })

  function finishStream(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    outputTokens: number,
    inputTokens: number,
    stopReason: string,
  ) {
    controller.enqueue(
      encoder.encode(
        formatSSE(
          'message_delta',
          JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          }),
        ),
      ),
    )
    controller.enqueue(
      encoder.encode(
        formatSSE(
          'message_stop',
          JSON.stringify({
            type: 'message_stop',
            'amazon-bedrock-invocationMetrics': {
              inputTokenCount: inputTokens,
              outputTokenCount: outputTokens,
              invocationLatency: 0,
              firstByteLatency: 0,
            },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          }),
        ),
      ),
    )
    controller.close()
  }

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

// ── Main fetch interceptor ──────────────────────────────────────────

let llamaAgent: import('http').Agent | null = null

function getLlamaAgent(): import('http').Agent | null {
  if (llamaAgent) return llamaAgent
  try {
    const http = require('http') as typeof import('http')
    llamaAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: 60000,
    })
    return llamaAgent
  } catch {
    return null
  }
}

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes
 * them to a local llama.cpp server's OpenAI-compatible endpoint.
 */
export function createLlamaFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const completionsUrl = getLlamaCompletionsUrl()
  const agent = getLlamaAgent()

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    const { openaiBody, model, isStreaming } = translateToOpenAI(anthropicBody)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: isStreaming ? 'text/event-stream' : 'application/json',
      Connection: 'keep-alive',
    }
    const apiKey = getLlamaApiKey()
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const timeout = getLlamaTimeoutMs()
    const abortController = new AbortController()
    const timeoutId = setTimeout(() => abortController.abort(), timeout)

    let llamaResponse: Response
    try {
      const fetchOptions: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(openaiBody),
        signal: abortController.signal,
      }
      if (agent) {
        (fetchOptions as any).agent = agent
      }
      llamaResponse = await globalThis.fetch(completionsUrl, fetchOptions)
    } catch (err) {
      clearTimeout(timeoutId)
      console.error(`[llama-fetch-adapter] Connection error: ${err}`)
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Llama server connection error: ${String(err)}`,
        },
      }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }

    clearTimeout(timeoutId)

    if (!llamaResponse.ok) {
      const errorText = await llamaResponse.text().catch(() => '')
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Llama server returned ${llamaResponse.status}: ${errorText}`,
        },
      }), { status: llamaResponse.status, headers: { 'Content-Type': 'application/json' } })
    }

    if (isStreaming) {
      return translateOpenAIStreamToAnthropic(llamaResponse, model)
    }

    try {
      const openaiJson = await llamaResponse.json() as Record<string, unknown>
      const anthropicJson = translateOpenAIResponseToAnthropic(openaiJson, model)
      return new Response(JSON.stringify(anthropicJson), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': `msg_llama_${Date.now()}`,
        },
      })
    } catch (err) {
      console.error(`[llama-fetch-adapter] Failed to parse non-streaming response: ${err}`)
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Failed to parse llama server response: ${String(err)}`,
        },
      }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
  }
}
