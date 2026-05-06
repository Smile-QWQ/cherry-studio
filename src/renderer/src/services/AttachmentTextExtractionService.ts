import { loggerService } from '@logger'
import AiProvider from '@renderer/aiCore/AiProvider'
import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Assistant, FileMetadata, ImageProcessMethod, Model, OcrProvider } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { StreamTextParams } from '@renderer/types/aiCoreTypes'
import type {
  AttachmentExtractionFailure,
  AttachmentExtractionItem,
  FileMessageBlock,
  ImageMessageBlock,
  MessageBlock
} from '@renderer/types/newMessage'
import type { OcrResult } from '@renderer/types/ocr'
import i18n from 'i18next'

const logger = loggerService.withContext('AttachmentTextExtractionService')

/**
 * 注入到模型隐藏上下文中的附件提取结果上限。
 *
 * 这里的限制是发送前防线，而不是底层文件读取能力限制：
 * - 单文件最多 20k，避免某一个超长附件吞掉全部上下文；
 * - 总量最多 60k，避免一次发送把对话模型上下文完全挤满。
 */
export const ATTACHMENT_INJECTION_MAX_FILE_CHARS = 20_000
export const ATTACHMENT_INJECTION_MAX_TOTAL_CHARS = 60_000

type ExtractionSource = 'ocr' | 'vision_model' | 'document'

export type AttachmentExtractionResult = {
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
  // 目的是在纯文本模型发送前拿到可作为隐藏上下文注入的图片描述，
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

const formatSourceLabel = (source: AttachmentExtractionItem['source']) => {
  switch (source) {
    case 'ocr':
      return '图片 OCR'
    case 'vision_model':
      return '视觉模型'
    case 'document':
      return '文档抽取'
  }
}

const buildAttachmentContextSection = (index: number, item: AttachmentExtractionItem) => {
  const truncatedHint = item.truncated ? '\n[该附件结果已截断]' : ''
  return [
    `[附件 ${index}] ${item.fileName}`,
    `来源：${formatSourceLabel(item.source)}`,
    item.text + truncatedHint
  ].join('\n')
}

export function buildAttachmentHiddenContext(
  results: AttachmentExtractionItem[],
  failed: AttachmentExtractionFailure[] = []
) {
  if (results.length === 0 && failed.length === 0) {
    return ''
  }

  const sections = [
    '[附件提取隐藏上下文]',
    '以下内容来自当前用户附件的提取结果，不是用户直接输入的正文。',
    '图片 OCR 结果可能存在识别误差、顺序错乱、漏字或噪声。',
    '请仅基于这些提取文本做保守判断，不要声称自己直接看到了图片本身。'
  ]

  if (results.length > 0) {
    sections.push('', '【附件提取成功结果】')
    results.forEach((item, index) => {
      sections.push(buildAttachmentContextSection(index + 1, item), '')
    })
  }

  if (failed.length > 0) {
    sections.push('【附件提取失败】')
    failed.forEach((item, index) => {
      sections.push(`[失败 ${index + 1}] ${item.fileName}\n原因：${item.error}`, '')
    })
  }

  return sections.join('\n').trim()
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
        // 图片只有在纯文本模型需要“预处理提取文本”时才会走到这里。
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

      const remaining = ATTACHMENT_INJECTION_MAX_TOTAL_CHARS - totalInjectedChars
      if (remaining <= 0) {
        break
      }

      const totalLimited = truncateText(extractedText, remaining)
      if (!totalLimited.text.trim()) {
        break
      }

      totalInjectedChars += totalLimited.text.length
      results.push({
        fileId: file.id,
        fileName: file.origin_name,
        text: totalLimited.text,
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
