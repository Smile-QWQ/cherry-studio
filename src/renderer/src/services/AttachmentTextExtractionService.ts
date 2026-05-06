import { loggerService } from '@logger'
import AiProvider from '@renderer/aiCore/AiProvider'
import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Assistant, FileMetadata, ImageProcessMethod, Model, OcrProvider } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { StreamTextParams } from '@renderer/types/aiCoreTypes'
import type { FileMessageBlock, ImageMessageBlock, MessageBlock } from '@renderer/types/newMessage'
import type { OcrResult } from '@renderer/types/ocr'
import i18n from 'i18next'

const logger = loggerService.withContext('AttachmentTextExtractionService')

/**
 * 注入到用户正文中的附件提取结果上限。
 *
 * 这里的限制是发送前防线，而不是底层文件读取能力限制：
 * - 单文件最多 20k，避免某一个超长附件吞掉全部上下文；
 * - 总量最多 60k，避免一次发送把对话模型上下文完全挤满。
 */
export const ATTACHMENT_INJECTION_MAX_FILE_CHARS = 20_000
export const ATTACHMENT_INJECTION_MAX_TOTAL_CHARS = 60_000

type ExtractionSource = 'ocr' | 'vision_model' | 'document'

export type AttachmentExtractionItem = {
  fileId: string
  fileName: string
  text: string
  source: ExtractionSource
  truncated: boolean
  blockType: 'image' | 'file'
}

export type AttachmentExtractionFailure = {
  fileId: string
  fileName: string
  error: string
}

export type AttachmentExtractionResult = {
  text: string
  results: AttachmentExtractionItem[]
  failed: AttachmentExtractionFailure[]
  hasAnySuccess: boolean
  hasProcessableAttachments: boolean
  usedVisionFallbackToOcr: boolean
  totalInjectedChars: number
}

type ExtractAttachmentTextsParams = {
  files: FileMetadata[]
  imageProcessMethod: ImageProcessMethod
  imageProvider?: OcrProvider
  visionModel?: Model
  ocr?: (file: FileMetadata, provider: OcrProvider) => Promise<string | OcrResult>
}

type ProcessImageResult = {
  text: string
  source: 'ocr' | 'vision_model'
  usedVisionFallbackToOcr?: boolean
}

const normalizeText = (value: string) => value.replace(/\r\n/g, '\n').trim()

const truncateText = (text: string, maxChars: number) => {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }

  const notice = `\n\n[内容已截断，仅保留前 ${maxChars} 个字符]`
  const body = text.slice(0, Math.max(0, maxChars - notice.length))
  return {
    text: body + notice,
    truncated: true
  }
}

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isTextLikeFile = (file: FileMetadata) => file.type === FILE_TYPE.TEXT || file.type === FILE_TYPE.DOCUMENT

const isImageFile = (file: FileMetadata) => file.type === FILE_TYPE.IMAGE

const shouldProcessImageForTextModel = (imageProcessMethod: ImageProcessMethod) => imageProcessMethod !== 'off'

async function readFileText(file: FileMetadata): Promise<string> {
  // 这里优先读取上传后的持久化文件，而不是原始 external path。
  // 这样 Home Chat / Agent Session 都能共享一致的发送前语义，
  // 也避免原路径在后续被移动、不可访问时出现行为漂移。
  return normalizeText(await window.api.file.read(file.id + file.ext, true))
}

async function runOcr(file: FileMetadata, imageProvider?: OcrProvider, ocr?: ExtractAttachmentTextsParams['ocr']) {
  if (!imageProvider || !ocr) {
    throw new Error(i18n.t('ocr.error.not_found'))
  }

  const result = await ocr(file, imageProvider)
  const text = typeof result === 'string' ? result : result.text
  return normalizeText(text)
}

async function describeImageWithVisionModel(file: FileMetadata, visionModel: Model): Promise<string> {
  // 这里复用现有 AI provider 链路做“一次性视觉理解”，
  // 目的是在纯文本模型发送前拿到可注入正文的图片描述，
  // 而不是改动正式对话消息的多模态上传协议。
  const base64Image = await window.api.file.base64Image(file.name)
  const provider = getProviderByModel(visionModel)
  const assistant = {
    id: 'attachment-vision',
    name: 'attachment-vision',
    prompt: '',
    topics: [],
    type: 'assistant',
    model: visionModel,
    settings: {
      streamOutput: false,
      temperature: 0,
      topP: 1,
      contextCount: 0,
      reasoning_effort: 'none',
      toolUseMode: 'function'
    }
  } as unknown as Assistant

  const ai = new AiProvider(visionModel, provider)
  const prompt = [
    '请阅读并理解这张图片。',
    '输出适合注入到文本模型上下文中的中文结果。',
    '优先包含：主体内容、关键信息、可见文字、表格/布局、重要细节。',
    '不要输出寒暄，不要解释你做了什么。'
  ].join('\n')

  const params = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image: base64Image.base64, mediaType: base64Image.mime }
        ]
      }
    ]
  } as StreamTextParams

  const result = await ai.completions(visionModel.id, params, {
    streamOutput: false,
    enableReasoning: false,
    isPromptToolUse: false,
    isSupportedToolUse: false,
    enableWebSearch: false,
    enableGenerateImage: false,
    enableUrlContext: false,
    assistant,
    callType: 'attachment-vision'
  })

  return normalizeText(result.getText() || '')
}

async function processImage(
  file: FileMetadata,
  imageProcessMethod: ImageProcessMethod,
  imageProvider: OcrProvider | undefined,
  visionModel: Model | undefined,
  ocr: ExtractAttachmentTextsParams['ocr']
): Promise<ProcessImageResult | null> {
  if (imageProcessMethod === 'off') {
    return null
  }

  if (imageProcessMethod === 'ocr') {
    return {
      text: await runOcr(file, imageProvider, ocr),
      source: 'ocr'
    }
  }

  if (visionModel) {
    try {
      return {
        text: await describeImageWithVisionModel(file, visionModel),
        source: 'vision_model'
      }
    } catch (error) {
      // 视觉理解失败不应中断整条发送链。
      // 这里按需求自动回退 OCR，尽量让“纯文本模型 + 图片”仍可用。
      logger.warn(`Vision model extraction failed for ${file.origin_name}, falling back to OCR.`, error as Error)
      return {
        text: await runOcr(file, imageProvider, ocr),
        source: 'ocr',
        usedVisionFallbackToOcr: true
      }
    }
  }

  return {
    text: await runOcr(file, imageProvider, ocr),
    source: 'ocr',
    usedVisionFallbackToOcr: true
  }
}

const formatAttachmentSection = (index: number, fileName: string, text: string) =>
  `[附件 ${index}] ${fileName}\n${text}`

export function buildAttachmentInjectedContent(originalText: string, extractedText: string) {
  if (!extractedText) {
    return originalText
  }

  // 防止重复注入：例如重发消息、上层误传已拼接文本时，不再重复追加同一段附件内容。
  if (originalText.includes(extractedText)) {
    return originalText
  }

  const separator = '\n\n---\n以下是附件提取内容：\n\n'
  const baseText = originalText.trim()
  return baseText ? `${baseText}${separator}${extractedText}` : `以下是附件提取内容：\n\n${extractedText}`
}

export async function extractAttachmentTexts({
  files,
  imageProcessMethod,
  imageProvider,
  visionModel,
  ocr
}: ExtractAttachmentTextsParams): Promise<AttachmentExtractionResult> {
  if (!files.length) {
    return {
      text: '',
      results: [],
      failed: [],
      hasAnySuccess: false,
      hasProcessableAttachments: false,
      usedVisionFallbackToOcr: false,
      totalInjectedChars: 0
    }
  }

  const results: AttachmentExtractionItem[] = []
  const failed: AttachmentExtractionFailure[] = []
  const sections: string[] = []
  let totalInjectedChars = 0
  let hasProcessableAttachments = false
  let usedVisionFallbackToOcr = false

  for (const file of files) {
    try {
      let extractedText = ''
      let source: ExtractionSource | undefined
      let truncated = false

      if (isTextLikeFile(file)) {
        hasProcessableAttachments = true
        extractedText = await readFileText(file)
        source = 'document'
      } else if (isImageFile(file) && shouldProcessImageForTextModel(imageProcessMethod)) {
        // 图片只有在纯文本模型需要“预处理注入正文”时才会走到这里。
        // 对视觉模型本身，仍保持既有传图链路，不在这里抢处理权。
        hasProcessableAttachments = true
        const imageResult = await processImage(file, imageProcessMethod, imageProvider, visionModel, ocr)
        if (imageResult) {
          extractedText = imageResult.text
          source = imageResult.source
          usedVisionFallbackToOcr = usedVisionFallbackToOcr || !!imageResult.usedVisionFallbackToOcr
        }
      }

      extractedText = normalizeText(extractedText)
      if (!source || !extractedText) {
        continue
      }

      const truncatedPerFile = truncateText(extractedText, ATTACHMENT_INJECTION_MAX_FILE_CHARS)
      extractedText = truncatedPerFile.text
      truncated = truncatedPerFile.truncated

      const section = formatAttachmentSection(results.length + 1, file.origin_name, extractedText)
      const remaining = ATTACHMENT_INJECTION_MAX_TOTAL_CHARS - totalInjectedChars
      if (remaining <= 0) {
        break
      }

      // 总量截断发生时直接停止后续注入，避免后面的附件结果部分丢失却看起来像完整输出。
      const totalLimited = truncateText(section, remaining)
      if (!totalLimited.text.trim()) {
        break
      }

      totalInjectedChars += totalLimited.text.length
      sections.push(totalLimited.text)
      results.push({
        fileId: file.id,
        fileName: file.origin_name,
        text: extractedText,
        source,
        truncated: truncated || totalLimited.truncated,
        blockType: file.type === FILE_TYPE.IMAGE ? 'image' : 'file'
      })

      if (totalLimited.truncated) {
        break
      }
    } catch (error) {
      // 单附件失败不能中断整体发送：这里只记失败，继续处理下一个附件。
      const errorMessage = toErrorMessage(error)
      logger.warn(`Failed to extract attachment text for ${file.origin_name}:`, error as Error)
      failed.push({
        fileId: file.id,
        fileName: file.origin_name,
        error: errorMessage
      })
    }
  }

  return {
    text: sections.join('\n\n'),
    results,
    failed,
    hasAnySuccess: results.length > 0,
    hasProcessableAttachments,
    usedVisionFallbackToOcr,
    totalInjectedChars
  }
}

export function hasVisualExtractionResult(result: AttachmentExtractionResult) {
  return result.results.some((item) => item.blockType === 'image')
}

export function applyAttachmentProcessedResultsToBlocks(
  blocks: Array<ImageMessageBlock | FileMessageBlock | MessageBlock>,
  results: AttachmentExtractionItem[]
) {
  const resultMap = new Map(results.map((item) => [item.fileId, item]))
  blocks.forEach((block) => {
    if (!('file' in block) || !block.file) return
    const result = resultMap.get(block.file.id)
    if (!result) return
    if ('metadata' in block) {
      // 目前只给已有 metadata 的 block 写 processedResult。
      // 这次需求明确要求图片 block 支持该字段；
      // 文件 block 仍保留原结构，避免扩大类型面和渲染面。
      block.metadata = {
        ...block.metadata,
        processedResult: result.text
      }
    }
  })
}
