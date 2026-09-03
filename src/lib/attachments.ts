import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Attachment } from '../types'

type Pdfjs = typeof import('pdfjs-dist')

// pdf.js is a megabyte of JavaScript, so keep it out of the initial bundle
// and only pay for it when someone actually attaches a PDF.
let pdfjsPromise: Promise<Pdfjs> | null = null
// One shared worker for every document. If pdf.js creates the worker itself it
// also terminates it in loadingTask.destroy(), and the next conversion then
// hangs forever waiting on a dead worker.
let worker: InstanceType<Pdfjs['PDFWorker']> | null = null

const loadPdfjs = () => {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    return pdfjs
  })
  return pdfjsPromise
}

// A long PDF would blow past the model's context window as images, so cap it
// and tell the user which pages were actually sent.
export const MAX_PDF_PAGES = 8

// Vision models downscale anyway; this keeps data URLs to a sane size.
const MAX_PAGE_EDGE = 1600

const makeId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(16).slice(2)}`

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })

export interface FileConversion {
  attachments: Attachment[]
  /** Pages beyond MAX_PDF_PAGES that were not sent, so the UI can say so. */
  omittedPages: number
}

const renderPdfPages = async (file: File): Promise<FileConversion> => {
  const pdfjs = await loadPdfjs()
  if (!worker || worker.destroyed) worker = new pdfjs.PDFWorker()

  const loadingTask = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    worker,
  })
  const document_ = await loadingTask.promise

  try {
    const pageCount = Math.min(document_.numPages, MAX_PDF_PAGES)
    const pages: Attachment[] = []

    for (let number = 1; number <= pageCount; number += 1) {
      const page = await document_.getPage(number)
      const unscaled = page.getViewport({ scale: 1 })
      const scale = Math.min(
        2,
        MAX_PAGE_EDGE / Math.max(unscaled.width, unscaled.height),
      )
      const viewport = page.getViewport({ scale })

      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)

      const context = canvas.getContext('2d')
      if (!context) throw new Error('This browser has no 2D canvas support')

      // PDF pages are transparent; without this they render on black.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)

      await page.render({ canvas, canvasContext: context, viewport }).promise
      page.cleanup()

      pages.push({
        id: makeId(),
        name: `${file.name} · page ${number}`,
        dataUrl: canvas.toDataURL('image/jpeg', 0.85),
      })
    }

    return {
      attachments: pages,
      omittedPages: document_.numPages - pageCount,
    }
  } finally {
    // Releases the parsed document but leaves the shared worker alive.
    await loadingTask.destroy()
  }
}

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

const isPdf = (file: File) =>
  file.type === 'application/pdf' ||
  file.type === 'application/x-pdf' ||
  extensionOf(file.name) === '.pdf'

const isImage = (file: File) =>
  file.type.startsWith('image/') ||
  ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(
    extensionOf(file.name),
  )

export const attachmentsFromFile = async (
  file: File,
): Promise<FileConversion> => {
  if (isPdf(file)) {
    return renderPdfPages(file)
  }

  if (isImage(file)) {
    return {
      attachments: [
        { id: makeId(), name: file.name, dataUrl: await readAsDataUrl(file) },
      ],
      omittedPages: 0,
    }
  }

  throw new Error(`${file.name} is not an image or a PDF`)
}
