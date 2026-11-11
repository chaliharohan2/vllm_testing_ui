import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModels, headersFor } from './vllm'

describe('headersFor', () => {
  it('sends the API key as a Bearer token', () => {
    expect(headersFor('  secret-key  ')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret-key',
    })
  })

  it('omits the header when the server runs without a key', () => {
    expect(headersFor('   ')).toEqual({ 'Content-Type': 'application/json' })
  })
})

describe('fetchModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authorizes model discovery with the current API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchModels('live-key')).resolves.toEqual(['model-a'])
    expect(fetchMock).toHaveBeenCalledWith('/v1/models', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer live-key',
      },
      signal: undefined,
    })
  })
})
