import { loggerService } from '@logger'
import {
  type AttachmentExtractionResult,
  extractAttachmentTexts
} from '@renderer/services/AttachmentTextExtractionService'
import FileManager from '@renderer/services/FileManager'
import * as RendererOcrService from '@renderer/services/ocr/OcrService'
import type {
  AttachmentExtractionLimitMode,
  FileMetadata,
  ImageProcessMethod,
  Model,
  OcrProvider
} from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { AttachmentExtractionFailure, AttachmentExtractionItem } from '@renderer/types/newMessage'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const logger = loggerService.withContext('useAttachmentPreprocess')

export type AttachmentPreprocessStatus = 'pending' | 'uploading' | 'processing' | 'completed' | 'failed'

export type AttachmentPreprocessState = {
  status: AttachmentPreprocessStatus
  item?: AttachmentExtractionItem
  failure?: AttachmentExtractionFailure
  usedVisionFallbackToOcr?: boolean
}

export type AttachmentPreprocessSnapshot = AttachmentExtractionResult & {
  items: AttachmentExtractionItem[]
  hasPendingProcessableAttachments: boolean
}

type UseAttachmentPreprocessParams = {
  files: FileMetadata[]
  setFiles: Dispatch<SetStateAction<FileMetadata[]>>
  enabled: boolean
  allowDocuments: boolean
  imageProcessMethod: ImageProcessMethod
  imageProvider?: OcrProvider
  visionModel?: Model
  attachmentExtractionLimitMode: AttachmentExtractionLimitMode
  attachmentExtractionMaxFileChars: number
  attachmentExtractionMaxTotalChars: number
}

const shouldPreprocessFile = (
  file: FileMetadata,
  enabled: boolean,
  allowDocuments: boolean,
  imageProcessMethod: ImageProcessMethod
) => {
  if (!enabled) {
    return false
  }

  if (file.type === FILE_TYPE.TEXT || file.type === FILE_TYPE.DOCUMENT) {
    return allowDocuments
  }

  return file.type === FILE_TYPE.IMAGE && imageProcessMethod !== 'off'
}

const removeMissingStates = (
  prev: Record<string, AttachmentPreprocessState>,
  files: FileMetadata[]
): Record<string, AttachmentPreprocessState> => {
  const fileIds = new Set(files.map((file) => file.id))
  const next = Object.fromEntries(Object.entries(prev).filter(([fileId]) => fileIds.has(fileId)))
  return next
}

export const useAttachmentPreprocess = ({
  files,
  setFiles,
  enabled,
  allowDocuments,
  imageProcessMethod,
  imageProvider,
  visionModel,
  attachmentExtractionLimitMode,
  attachmentExtractionMaxFileChars,
  attachmentExtractionMaxTotalChars
}: UseAttachmentPreprocessParams) => {
  const [states, setStates] = useState<Record<string, AttachmentPreprocessState>>({})
  const statesRef = useRef(states)
  const filesRef = useRef(files)
  const scheduledRef = useRef(new Set<string>())
  const queueRef = useRef(Promise.resolve())

  useEffect(() => {
    statesRef.current = states
  }, [states])

  useEffect(() => {
    filesRef.current = files
    setStates((prev) => removeMissingStates(prev, files))
  }, [files])

  const updateState = useCallback(
    (fileId: string, updater: (prev?: AttachmentPreprocessState) => AttachmentPreprocessState) => {
      setStates((prev) => ({
        ...prev,
        [fileId]: updater(prev[fileId])
      }))
    },
    []
  )

  const moveStateKey = useCallback((fromId: string, toId: string, nextState: AttachmentPreprocessState) => {
    setStates((prev) => {
      const next = { ...prev }
      delete next[fromId]
      next[toId] = nextState
      return next
    })
  }, [])

  const processSingleFile = useCallback(
    async (file: FileMetadata) => {
      const originalId = file.id
      let currentFile = file
      let currentId = file.id

      const isStillTracked = () => filesRef.current.some((item) => item.id === originalId || item.id === currentId)

      try {
        if (!isStillTracked()) {
          return
        }

        if (!FileManager.isStoredFile(currentFile)) {
          updateState(currentId, () => ({ status: 'uploading' }))
          const uploadedFile = await FileManager.uploadFile(currentFile)

          if (!isStillTracked()) {
            await FileManager.deleteFile(uploadedFile.id).catch((error) => {
              logger.warn('Failed to cleanup uploaded attachment after removal', error as Error)
            })
            return
          }

          currentFile = uploadedFile
          currentId = uploadedFile.id
          scheduledRef.current.add(currentId)
          setFiles((prev) => {
            const targetIndex = prev.findIndex((item) => item.id === originalId)
            if (targetIndex === -1) {
              return prev
            }
            const next = [...prev]
            next[targetIndex] = uploadedFile
            return next
          })
          moveStateKey(originalId, currentId, { status: 'pending' })
        } else {
          updateState(currentId, () => ({ status: 'pending' }))
        }

        if (!shouldPreprocessFile(currentFile, enabled, allowDocuments, imageProcessMethod)) {
          return
        }

        updateState(currentId, () => ({ status: 'processing' }))

        const extraction = await extractAttachmentTexts({
          files: [currentFile],
          imageProcessMethod,
          imageProvider,
          visionModel,
          ocr: (ocrFile, provider) => RendererOcrService.ocr(ocrFile as any, provider),
          limitMode: attachmentExtractionLimitMode,
          maxFileChars: attachmentExtractionMaxFileChars,
          maxTotalChars: attachmentExtractionMaxTotalChars
        })

        if (!isStillTracked()) {
          return
        }

        const item = extraction.results[0]
        const failure = extraction.failed[0]

        if (item) {
          updateState(currentId, () => ({
            status: 'completed',
            item,
            usedVisionFallbackToOcr: extraction.usedVisionFallbackToOcr
          }))
          return
        }

        if (failure) {
          updateState(currentId, () => ({
            status: 'failed',
            failure,
            usedVisionFallbackToOcr: extraction.usedVisionFallbackToOcr
          }))
          return
        }

        updateState(currentId, () => ({
          status: 'failed',
          failure: {
            fileId: currentId,
            fileName: currentFile.origin_name,
            error: 'No extractable attachment content returned'
          },
          usedVisionFallbackToOcr: extraction.usedVisionFallbackToOcr
        }))
      } catch (error) {
        const failure: AttachmentExtractionFailure = {
          fileId: currentId,
          fileName: currentFile.origin_name,
          error: error instanceof Error ? error.message : String(error)
        }
        if (isStillTracked()) {
          updateState(currentId, () => ({ status: 'failed', failure }))
        }
        logger.warn('Attachment preprocessing failed', error as Error)
      } finally {
        scheduledRef.current.delete(originalId)
        scheduledRef.current.delete(currentId)
      }
    },
    [
      allowDocuments,
      attachmentExtractionLimitMode,
      attachmentExtractionMaxFileChars,
      attachmentExtractionMaxTotalChars,
      enabled,
      imageProcessMethod,
      imageProvider,
      moveStateKey,
      setFiles,
      updateState,
      visionModel
    ]
  )

  useEffect(() => {
    files.forEach((file) => {
      if (!shouldPreprocessFile(file, enabled, allowDocuments, imageProcessMethod)) {
        return
      }

      if (scheduledRef.current.has(file.id) || statesRef.current[file.id]) {
        return
      }

      scheduledRef.current.add(file.id)
      updateState(file.id, () => ({ status: 'pending' }))

      queueRef.current = queueRef.current
        .catch(() => undefined)
        .then(() => processSingleFile(file))
        .catch((error) => {
          logger.warn('Attachment preprocessing queue failed', error as Error)
        })
    })
  }, [allowDocuments, enabled, files, imageProcessMethod, processSingleFile, updateState])

  const removeAttachment = useCallback(
    (file: FileMetadata) => {
      setFiles((prev) => prev.filter((item) => item.id !== file.id))
      setStates((prev) => {
        const next = { ...prev }
        delete next[file.id]
        return next
      })

      if (FileManager.isStoredFile(file)) {
        void FileManager.deleteFile(file.id).catch((error) => {
          logger.warn('Failed to delete pre-uploaded attachment after removal', error as Error)
        })
      }
    },
    [setFiles]
  )

  const snapshot = useMemo(() => {
    const items: AttachmentExtractionItem[] = []
    const failed: AttachmentExtractionFailure[] = []
    let hasPendingProcessableAttachments = false
    let hasProcessableAttachments = false
    let usedVisionFallbackToOcr = false

    for (const file of files) {
      if (!shouldPreprocessFile(file, enabled, allowDocuments, imageProcessMethod)) {
        continue
      }

      hasProcessableAttachments = true
      const state = states[file.id]
      if (!state || state.status === 'pending' || state.status === 'uploading' || state.status === 'processing') {
        hasPendingProcessableAttachments = true
        continue
      }

      if (state.item) {
        items.push(state.item)
        usedVisionFallbackToOcr = usedVisionFallbackToOcr || !!state.usedVisionFallbackToOcr
      } else if (state.failure) {
        failed.push(state.failure)
      }
    }

    const totalInjectedChars = items.reduce((sum, item) => sum + item.text.length, 0)

    return {
      results: items,
      items,
      failed,
      hasAnySuccess: items.length > 0,
      hasProcessableAttachments,
      hasPendingProcessableAttachments,
      usedVisionFallbackToOcr,
      totalInjectedChars
    } satisfies AttachmentPreprocessSnapshot
  }, [allowDocuments, enabled, files, imageProcessMethod, states])

  return {
    attachmentPreprocessStates: states,
    attachmentPreprocessSnapshot: snapshot,
    removeAttachment
  }
}
