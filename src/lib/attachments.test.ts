import { describe, expect, it } from 'vitest'
import { attachmentsFromFile } from './attachments'

describe('attachmentsFromFile', () => {
  it('sends images through as a data URL', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', {
      type: 'image/png',
    })

    const result = await attachmentsFromFile(file)

    expect(result.omittedPages).toBe(0)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].name).toBe('shot.png')
    expect(result.attachments[0].dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('accepts a JPEG that only has an extension', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', {
      type: '',
    })

    const result = await attachmentsFromFile(file)
    expect(result.attachments[0].name).toBe('photo.jpg')
  })

  it('rejects files that are not images or PDFs', async () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    await expect(attachmentsFromFile(file)).rejects.toThrow('not an image or a PDF')
  })
})
