import type { Model, OcrProvider } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { FileMetadata } from '@renderer/types/file'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDefaultModelMock, getProviderByModelMock } = vi.hoisted(() => ({
  getDefaultModelMock: vi.fn(),
  getProviderByModelMock: vi.fn()
}))

const { getTextMock, completionsMock } = vi.hoisted(() => ({
  getTextMock: vi.fn(),
  completionsMock: vi.fn()
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultModel: getDefaultModelMock,
  getProviderByModel: getProviderByModelMock
}))

vi.mock('@renderer/aiCore/AiProvider', () => ({
  default: vi.fn().mockImplementation(() => ({
    completions: completionsMock
  }))
}))

import {
  ATTACHMENT_INJECTION_MAX_FILE_CHARS,
  ATTACHMENT_INJECTION_MAX_TOTAL_CHARS,
  buildAttachmentInjectedContent,
  extractAttachmentTexts,
  hasVisualExtractionResult
} from '../AttachmentTextExtractionService'

const visionModel: Model = {
  id: 'vision-model',
  name: 'Vision Model',
  provider: 'vision-provider',
  group: 'vision'
}

const textModel: Model = {
  id: 'text-model',
  name: 'Text Model',
  provider: 'text-provider',
  group: 'text'
}

const imageProvider: OcrProvider = {
  id: 'system',
  name: 'System OCR',
  capabilities: {
    image: true
  }
}

const createFile = (overrides: Partial<FileMetadata> = {}): FileMetadata => ({
  id: overrides.id ?? 'file-1',
  name: overrides.name ?? 'file-1.png',
  origin_name: overrides.origin_name ?? 'file-1.png',
  path: overrides.path ?? 'C:/tmp/file-1.png',
  size: overrides.size ?? 1024,
  ext: overrides.ext ?? '.png',
  type: overrides.type ?? FILE_TYPE.IMAGE,
  created_at: overrides.created_at ?? '2026-05-06T00:00:00.000Z',
  count: overrides.count ?? 1,
  ...overrides
})

describe('AttachmentTextExtractionService', () => {
  beforeEach(() => {
    getDefaultModelMock.mockReset()
    getProviderByModelMock.mockReset()
    completionsMock.mockReset()
    getTextMock.mockReset()

    getDefaultModelMock.mockReturnValue(textModel)
    getProviderByModelMock.mockReturnValue({ id: 'vision-provider', apiKey: 'test-key', type: 'openai' })
    getTextMock.mockReturnValue('vision result')
    completionsMock.mockResolvedValue({
      getText: getTextMock
    })

    vi.stubGlobal('window', {
      api: {
        file: {
          read: vi.fn(),
          readExternal: vi.fn(),
          base64Image: vi.fn()
        }
      },
      toast: {
        warning: vi.fn(),
        error: vi.fn()
      }
    } as unknown as Window & typeof globalThis)
  })

  it('returns empty result when no files are provided', async () => {
    const result = await extractAttachmentTexts({
      files: [],
      imageProcessMethod: 'ocr',
      imageProvider
    })

    expect(result).toEqual({
      text: '',
      hasAnySuccess: false,
      hasProcessableAttachments: false,
      results: [],
      failed: [],
      usedVisionFallbackToOcr: false,
      totalInjectedChars: 0
    })
  })

  it('extracts document text and injects formatted content', async () => {
    vi.mocked(window.api.file.read).mockResolvedValueOnce('Document content')
    const file = createFile({
      id: 'doc-1',
      name: 'doc-1.pdf',
      origin_name: 'manual.pdf',
      ext: '.pdf',
      type: FILE_TYPE.DOCUMENT
    })

    const result = await extractAttachmentTexts({
      files: [file],
      imageProcessMethod: 'ocr',
      imageProvider
    })

    expect(result.hasAnySuccess).toBe(true)
    expect(result.text).toContain('[附件 1] manual.pdf')
    expect(result.text).toContain('Document content')
    expect(result.failed).toEqual([])
    expect(result.results[0]?.blockType).toBe('file')
  })

  it('uses OCR for images when imageProcessMethod is ocr', async () => {
    const file = createFile()
    const ocr = vi.fn().mockResolvedValue('ocr result')

    const result = await extractAttachmentTexts({
      files: [file],
      imageProcessMethod: 'ocr',
      imageProvider,
      ocr
    })

    expect(ocr).toHaveBeenCalledWith(file, imageProvider)
    expect(result.text).toContain('ocr result')
    expect(result.results[0]?.source).toBe('ocr')
    expect(result.results[0]?.blockType).toBe('image')
  })

  it('uses configured vision model for images when imageProcessMethod is vision_model', async () => {
    vi.mocked(window.api.file.base64Image).mockResolvedValueOnce({
      base64: 'ZmFrZQ==',
      data: 'data:image/png;base64,ZmFrZQ==',
      mime: 'image/png'
    })

    const file = createFile()
    const result = await extractAttachmentTexts({
      files: [file],
      imageProcessMethod: 'vision_model',
      imageProvider,
      visionModel
    })

    expect(completionsMock).toHaveBeenCalled()
    expect(result.text).toContain('vision result')
    expect(result.results[0]?.source).toBe('vision_model')
    expect(result.results[0]?.blockType).toBe('image')
  })

  it('falls back to OCR when vision_model is selected but no vision model is configured', async () => {
    const ocr = vi.fn().mockResolvedValue('fallback ocr result')
    const file = createFile()

    const result = await extractAttachmentTexts({
      files: [file],
      imageProcessMethod: 'vision_model',
      imageProvider,
      ocr
    })

    expect(ocr).toHaveBeenCalled()
    expect(result.usedVisionFallbackToOcr).toBe(true)
    expect(result.results[0]?.source).toBe('ocr')
  })

  it('skips image extraction when imageProcessMethod is off', async () => {
    const file = createFile()
    const ocr = vi.fn()

    const result = await extractAttachmentTexts({
      files: [file],
      imageProcessMethod: 'off',
      imageProvider,
      ocr
    })

    expect(ocr).not.toHaveBeenCalled()
    expect(result.hasProcessableAttachments).toBe(false)
    expect(result.text).toBe('')
  })

  it('continues when one attachment fails and keeps successful ones', async () => {
    vi.mocked(window.api.file.read)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce('second file text')

    const failedFile = createFile({
      id: 'doc-failed',
      origin_name: 'failed.pdf',
      ext: '.pdf',
      type: FILE_TYPE.DOCUMENT
    })
    const okFile = createFile({
      id: 'doc-ok',
      origin_name: 'ok.txt',
      ext: '.txt',
      type: FILE_TYPE.TEXT
    })

    const result = await extractAttachmentTexts({
      files: [failedFile, okFile],
      imageProcessMethod: 'ocr',
      imageProvider
    })

    expect(result.hasAnySuccess).toBe(true)
    expect(result.failed).toHaveLength(1)
    expect(result.text).toContain('second file text')
  })

  it('truncates each file to 20k characters', async () => {
    const longText = 'a'.repeat(ATTACHMENT_INJECTION_MAX_FILE_CHARS + 100)
    vi.mocked(window.api.file.read).mockResolvedValueOnce(longText)

    const file = createFile({
      id: 'doc-long',
      origin_name: 'long.txt',
      ext: '.txt',
      type: FILE_TYPE.TEXT
    })

    const result = await extractAttachmentTexts({
      files: [file],
      imageProcessMethod: 'ocr',
      imageProvider
    })

    expect(result.results[0]?.text?.length).toBeLessThanOrEqual(ATTACHMENT_INJECTION_MAX_FILE_CHARS + 64)
    expect(result.results[0]?.truncated).toBe(true)
  })

  it('limits total injected characters to 60k', async () => {
    const large = 'x'.repeat(ATTACHMENT_INJECTION_MAX_FILE_CHARS)
    vi.mocked(window.api.file.read)
      .mockResolvedValueOnce(large)
      .mockResolvedValueOnce(large)
      .mockResolvedValueOnce(large)
      .mockResolvedValueOnce(large)

    const files = [1, 2, 3, 4].map((n) =>
      createFile({
        id: `doc-${n}`,
        origin_name: `doc-${n}.txt`,
        ext: '.txt',
        type: FILE_TYPE.TEXT
      })
    )

    const result = await extractAttachmentTexts({
      files,
      imageProcessMethod: 'ocr',
      imageProvider
    })

    expect(result.totalInjectedChars).toBeLessThanOrEqual(ATTACHMENT_INJECTION_MAX_TOTAL_CHARS)
    expect(result.text.length).toBeLessThanOrEqual(ATTACHMENT_INJECTION_MAX_TOTAL_CHARS + 1024)
  })

  it('builds merged content with clear delimiter', () => {
    const merged = buildAttachmentInjectedContent('hello', '[附件 1] a.png\ntext')
    expect(merged).toContain('hello')
    expect(merged).toContain('以下是附件提取内容')
    expect(merged).toContain('[附件 1] a.png')
  })

  it('does not duplicate injected content when original text already contains the same section', () => {
    const extracted = '[附件 1] a.png\ntext'
    const original = `hello\n\n---\n以下是附件提取内容：\n\n${extracted}`
    expect(buildAttachmentInjectedContent(original, extracted)).toBe(original)
  })

  it('detects whether visual extraction results exist', async () => {
    const ocr = vi.fn().mockResolvedValue('ocr result')
    const imageResult = await extractAttachmentTexts({
      files: [createFile()],
      imageProcessMethod: 'ocr',
      imageProvider,
      ocr
    })
    expect(hasVisualExtractionResult(imageResult)).toBe(true)

    vi.mocked(window.api.file.read).mockResolvedValueOnce('plain text')
    const textResult = await extractAttachmentTexts({
      files: [
        createFile({
          id: 'doc-1',
          origin_name: 'doc-1.txt',
          ext: '.txt',
          type: FILE_TYPE.TEXT
        })
      ],
      imageProcessMethod: 'ocr',
      imageProvider
    })
    expect(hasVisualExtractionResult(textResult)).toBe(false)
  })
})
