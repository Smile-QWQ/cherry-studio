import type { FileMetadata, Model, OcrProvider } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { uploadFileMock, deleteFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  deleteFileMock: vi.fn()
}))

const { extractAttachmentTextsMock } = vi.hoisted(() => ({
  extractAttachmentTextsMock: vi.fn()
}))

const { ocrMock } = vi.hoisted(() => ({
  ocrMock: vi.fn()
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    uploadFile: uploadFileMock,
    deleteFile: deleteFileMock,
    isStoredFile: (file: FileMetadata) => file.name === `${file.id}${file.ext}`
  }
}))

vi.mock('@renderer/services/AttachmentTextExtractionService', () => ({
  extractAttachmentTexts: extractAttachmentTextsMock
}))

vi.mock('@renderer/services/ocr/OcrService', () => ({
  ocr: ocrMock
}))

import { useAttachmentPreprocess } from '../useAttachmentPreprocess'

const imageProvider: OcrProvider = {
  id: 'system',
  name: 'System OCR',
  capabilities: {
    image: true
  }
}

const visionModel: Model = {
  id: 'vision-model',
  name: 'Vision Model',
  provider: 'vision-provider',
  group: 'vision'
}

const createFile = (overrides: Partial<FileMetadata> = {}): FileMetadata => ({
  id: overrides.id ?? 'file-1',
  name: overrides.name ?? 'temp_file.png',
  origin_name: overrides.origin_name ?? 'temp_file.png',
  path: overrides.path ?? 'C:/tmp/temp_file.png',
  size: overrides.size ?? 1024,
  ext: overrides.ext ?? '.png',
  type: overrides.type ?? FILE_TYPE.IMAGE,
  created_at: overrides.created_at ?? '2026-05-07T00:00:00.000Z',
  count: overrides.count ?? 1,
  ...overrides
})

describe('useAttachmentPreprocess', () => {
  beforeEach(() => {
    uploadFileMock.mockReset()
    deleteFileMock.mockReset()
    extractAttachmentTextsMock.mockReset()
    ocrMock.mockReset()
  })

  it('uploads and preprocesses attachments immediately after they are added', async () => {
    const originalFile = createFile()
    const uploadedFile = createFile({
      id: 'stored-1',
      name: 'stored-1.png',
      origin_name: originalFile.origin_name
    })

    uploadFileMock.mockResolvedValueOnce(uploadedFile)
    extractAttachmentTextsMock.mockResolvedValueOnce({
      results: [
        {
          fileId: uploadedFile.id,
          fileName: uploadedFile.origin_name,
          text: 'extracted image text',
          source: 'vision_model',
          truncated: false,
          blockType: 'image'
        }
      ],
      failed: [],
      hasAnySuccess: true,
      hasProcessableAttachments: true,
      usedVisionFallbackToOcr: false,
      totalInjectedChars: 20
    })

    let filesState = [originalFile]
    const setFiles = vi.fn((updater: React.SetStateAction<FileMetadata[]>) => {
      filesState = typeof updater === 'function' ? updater(filesState) : updater
    })

    const { result, rerender } = renderHook(
      ({ files }) =>
        useAttachmentPreprocess({
          files,
          setFiles,
          enabled: true,
          allowDocuments: true,
          imageProcessMethod: 'vision_model',
          imageProvider,
          visionModel,
          attachmentExtractionLimitMode: 'default',
          attachmentExtractionMaxFileChars: 20_000,
          attachmentExtractionMaxTotalChars: 60_000
        }),
      {
        initialProps: {
          files: filesState
        }
      }
    )

    await waitFor(() => {
      expect(uploadFileMock).toHaveBeenCalledWith(originalFile)
      expect(extractAttachmentTextsMock).toHaveBeenCalled()
    })

    rerender({ files: filesState })

    await waitFor(() => {
      expect(result.current.attachmentPreprocessStates[uploadedFile.id]?.status).toBe('completed')
    })

    expect(setFiles).toHaveBeenCalled()
    expect(result.current.attachmentPreprocessSnapshot.items[0]?.text).toBe('extracted image text')
    expect(result.current.attachmentPreprocessSnapshot.hasPendingProcessableAttachments).toBe(false)
    expect(extractAttachmentTextsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limitMode: 'default',
        maxFileChars: 20_000,
        maxTotalChars: 60_000
      })
    )
  })

  it('skips document preprocessing when documents are not allowed for the current model', async () => {
    const documentFile = createFile({
      id: 'doc-1',
      name: 'doc-1.pdf',
      origin_name: 'doc-1.pdf',
      ext: '.pdf',
      type: FILE_TYPE.DOCUMENT
    })

    const { result } = renderHook(() =>
      useAttachmentPreprocess({
        files: [documentFile],
        setFiles: vi.fn(),
        enabled: true,
        allowDocuments: false,
        imageProcessMethod: 'ocr',
        imageProvider,
        visionModel,
        attachmentExtractionLimitMode: 'default',
        attachmentExtractionMaxFileChars: 20_000,
        attachmentExtractionMaxTotalChars: 60_000
      })
    )

    expect(uploadFileMock).not.toHaveBeenCalled()
    expect(extractAttachmentTextsMock).not.toHaveBeenCalled()
    expect(result.current.attachmentPreprocessSnapshot.hasProcessableAttachments).toBe(false)
  })
})
