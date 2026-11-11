import type { ModelsResponse } from '../types'

export const headersFor = (apiKey: string): HeadersInit => {
  const token = apiKey.trim()

  return {
    'Content-Type': 'application/json',
    // Servers started without `--api-key` reject requests that carry an
    // Authorization header, so only send one when a key was supplied.
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as {
      error?: { message?: string }
      message?: string
    }
    return body.error?.message || body.message || response.statusText
  } catch {
    return response.statusText || `HTTP ${response.status}`
  }
}

export const fetchModels = async (
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const response = await fetch('/v1/models', {
    headers: headersFor(apiKey),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Could not load models: ${await errorMessage(response)}`)
  }

  const payload = (await response.json()) as ModelsResponse
  return payload.data.map(({ id }) => id).filter(Boolean).sort()
}
