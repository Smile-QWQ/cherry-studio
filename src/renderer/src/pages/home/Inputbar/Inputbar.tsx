import { loggerService } from '@logger'
import {
  isAutoEnableImageGenerationModel,
  isGenerateImageModel,
  isGenerateImageModels,
  isMandatoryWebSearchModel,
  isVisionModel,
  isVisionModels,
  isWebSearchModel
} from '@renderer/config/models'
import db from '@renderer/databases'
import { useAssistant, useDefaultModel } from '@renderer/hooks/useAssistant'
import { useInputText } from '@renderer/hooks/useInputText'
import { useMessageOperations, useTopicLoading } from '@renderer/hooks/useMessageOperations'
import { useOcrProviders } from '@renderer/hooks/useOcrProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { useTimer } from '@renderer/hooks/useTimer'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import {
  applyAttachmentProcessedResultsToBlocks,
  buildAttachmentInjectedContent,
  extractAttachmentTexts,
  hasVisualExtractionResult
} from '@renderer/services/AttachmentTextExtractionService'
import { CacheService } from '@renderer/services/CacheService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { checkRateLimit, getUserMessage } from '@renderer/services/MessagesService'
import * as RendererOcrService from '@renderer/services/ocr/OcrService'
import { spanManagerService } from '@renderer/services/SpanManagerService'
import { estimateTextTokens as estimateTxtTokens, estimateUserPromptUsage } from '@renderer/services/TokenService'
import WebSearchService from '@renderer/services/WebSearchService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { sendMessage as _sendMessage } from '@renderer/store/thunk/messageThunk'
import {
  type Assistant,
  type FileMetadata,
  type KnowledgeBase,
  type Model,
  type Topic,
  TopicType
} from '@renderer/types'
import type { MessageInputBaseParams } from '@renderer/types/newMessage'
import { delay } from '@renderer/utils'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import { debounce } from 'lodash'
import type { FC } from 'react'
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { InputbarCore } from './components/InputbarCore'
import InputbarTools from './InputbarTools'
import KnowledgeBaseInput from './KnowledgeBaseInput'
import MentionModelsInput from './MentionModelsInput'
import { getInputbarConfig } from './registry'
import TokenCount from './TokenCount'

const logger = loggerService.withContext('Inputbar')

const INPUTBAR_DRAFT_CACHE_KEY = 'inputbar-draft'
const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

const isImageBlock = (block: { type: string }) => block.type === 'image'

const getMentionedModelsCacheKey = (assistantId: string) => `inputbar-mentioned-models-${assistantId}`

const getValidatedCachedModels = (assistantId: string): Model[] => {
  const cached = CacheService.get<Model[]>(getMentionedModelsCacheKey(assistantId))
  if (!Array.isArray(cached)) return []
  return cached.filter((model) => model?.id && model?.name)
}

interface Props {
  assistant: Assistant
  setActiveTopic: (topic: Topic) => void
  topic: Topic
}

type ProviderActionHandlers = {
  resizeTextArea: () => void
  addNewTopic: () => void
  clearTopic: () => void
  onNewContext: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
  toggleExpanded: (nextState?: boolean) => void
}

interface InputbarInnerProps extends Props {
  actionsRef: React.RefObject<ProviderActionHandlers>
}

const Inputbar: FC<Props> = ({ assistant: initialAssistant, setActiveTopic, topic }) => {
  const actionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    clearTopic: () => {},
    onNewContext: () => {},
    onTextChange: () => {},
    toggleExpanded: () => {}
  })

  const [initialMentionedModels] = useState(() => getValidatedCachedModels(initialAssistant.id))

  const initialState = useMemo(
    () => ({
      files: [] as FileMetadata[],
      mentionedModels: initialMentionedModels,
      selectedKnowledgeBases: initialAssistant.knowledge_bases ?? [],
      isExpanded: false,
      couldAddImageFile: false,
      extensions: [] as string[]
    }),
    [initialMentionedModels, initialAssistant.knowledge_bases]
  )

  return (
    <InputbarToolsProvider
      initialState={initialState}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        addNewTopic: () => actionsRef.current.addNewTopic(),
        clearTopic: () => actionsRef.current.clearTopic(),
        onNewContext: () => actionsRef.current.onNewContext(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        toggleExpanded: (next) => actionsRef.current.toggleExpanded(next)
      }}>
      <InputbarInner
        assistant={initialAssistant}
        setActiveTopic={setActiveTopic}
        topic={topic}
        actionsRef={actionsRef}
      />
    </InputbarToolsProvider>
  )
}

const InputbarInner: FC<InputbarInnerProps> = ({ assistant: initialAssistant, setActiveTopic, topic, actionsRef }) => {
  const scope = topic.type ?? TopicType.Chat
  const config = getInputbarConfig(scope)

  const { files, mentionedModels, selectedKnowledgeBases } = useInputbarToolsState()
  const { setFiles, setMentionedModels, setSelectedKnowledgeBases } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const { text, setText } = useInputText({
    initialValue: CacheService.get<string>(INPUTBAR_DRAFT_CACHE_KEY) ?? '',
    onChange: (value) => CacheService.set(INPUTBAR_DRAFT_CACHE_KEY, value, DRAFT_CACHE_TTL)
  })
  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    isExpanded: textareaIsExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 500,
    minHeight: 30
  })

  const { assistant, addTopic, model, setModel, updateAssistant } = useAssistant(initialAssistant.id)
  const { sendMessageShortcut, showInputEstimatedTokens, enableQuickPanelTriggers, imageProcessMethod } = useSettings()
  const { visionModel } = useDefaultModel()
  const { imageProvider } = useOcrProviders()
  const [estimateTokenCount, setEstimateTokenCount] = useState(0)
  const [contextCount, setContextCount] = useState({ current: 0, max: 0 })

  const { t } = useTranslation()
  const { pauseMessages } = useMessageOperations(topic)
  const loading = useTopicLoading(topic)
  const dispatch = useAppDispatch()
  const isVisionAssistant = useMemo(() => isVisionModel(model), [model])
  const isGenerateImageAssistant = useMemo(() => isGenerateImageModel(model), [model])
  const { setTimeoutTimer } = useTimer()
  const isMultiSelectMode = useAppSelector((state) => state.runtime.chat.isMultiSelectMode)

  const isVisionSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isVisionModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isVisionAssistant),
    [mentionedModels, isVisionAssistant]
  )

  const isGenerateImageSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isGenerateImageModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isGenerateImageAssistant),
    [mentionedModels, isGenerateImageAssistant]
  )

  const canAddImageFile = useMemo(() => {
    // 纯文本模型现在也允许先挂图片附件。
    // 是否真正把图片送入模型，由发送前预处理分支决定：
    // - 视觉模型：保持既有传图行为；
    // - 非视觉模型：先抽取文本再注入正文。
    return true
  }, [])

  const canAddTextFile = useMemo(() => {
    return isVisionSupported || (!isVisionSupported && !isGenerateImageSupported)
  }, [isGenerateImageSupported, isVisionSupported])

  const supportedExts = useMemo(() => {
    if (canAddImageFile && canAddTextFile) {
      return [...imageExts, ...documentExts, ...textExts]
    }

    if (canAddImageFile) {
      return [...imageExts]
    }

    if (canAddTextFile) {
      return [...documentExts, ...textExts]
    }

    return []
  }, [canAddImageFile, canAddTextFile])

  useEffect(() => {
    setCouldAddImageFile(canAddImageFile)
  }, [canAddImageFile, setCouldAddImageFile])

  const onUnmount = useEffectEvent((id: string) => {
    CacheService.set(getMentionedModelsCacheKey(id), mentionedModels, DRAFT_CACHE_TTL)
  })

  useEffect(() => {
    return () => onUnmount(assistant.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.id])

  const placeholderText = enableQuickPanelTriggers
    ? t('chat.input.placeholder', { key: getSendMessageShortcutLabel(sendMessageShortcut) })
    : t('chat.input.placeholder_without_triggers', {
        key: getSendMessageShortcutLabel(sendMessageShortcut),
        defaultValue: t('chat.input.placeholder', {
          key: getSendMessageShortcutLabel(sendMessageShortcut)
        })
      })

  const sendMessage = useCallback(async () => {
    if (checkRateLimit(assistant)) {
      return
    }

    logger.info('Starting to send message')

    const parent = spanManagerService.startTrace(
      { topicId: topic.id, name: 'sendMessage', inputs: text },
      mentionedModels.length > 0 ? mentionedModels : [assistant.model]
    )
    void EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: topic.id, traceId: parent?.spanContext().traceId })

    try {
      const uploadedFiles = await FileManager.uploadFiles(files)

      const baseUserMessage: MessageInputBaseParams = { assistant, topic, content: text }
      if (uploadedFiles) {
        baseUserMessage.files = uploadedFiles
      }
      if (mentionedModels.length) {
        baseUserMessage.mentions = mentionedModels
      }

      let extractionResults: Awaited<ReturnType<typeof extractAttachmentTexts>> | undefined

      const shouldPreprocessAttachments = !isVisionSupported && !isGenerateImageSupported && uploadedFiles?.length
      if (shouldPreprocessAttachments) {
        // 只有“当前对话模型本身不支持视觉/生图”时，才把附件预处理结果注入正文。
        // 这样可以避免破坏视觉模型原本的图片输入协议。
        extractionResults = await extractAttachmentTexts({
          files: uploadedFiles,
          imageProcessMethod,
          imageProvider,
          visionModel,
          ocr: (file, provider) => RendererOcrService.ocr(file as any, provider)
        })

        if (!text.trim() && extractionResults.hasProcessableAttachments && !extractionResults.hasAnySuccess) {
          // 用户只发附件且全部抽取失败时，阻止发送。
          // 否则纯文本模型会收到一个空消息体，既无正文也无可理解附件文本。
          window.toast.error(t('chat.input.file_error'))
          return
        }

        if (extractionResults.usedVisionFallbackToOcr) {
          window.toast.warning(t('message.error.file.vision.model_fallback_to_ocr'))
        }

        baseUserMessage.content = buildAttachmentInjectedContent(text, extractionResults.text)
      }

      baseUserMessage.usage = await estimateUserPromptUsage(baseUserMessage)

      const { message, blocks } = getUserMessage(baseUserMessage)
      if (extractionResults && hasVisualExtractionResult(extractionResults)) {
        // 保留原附件 block，同时把图片处理结果挂到 block metadata。
        // 这给后续 UI 展示或重复发送去重留下扩展空间。
        applyAttachmentProcessedResultsToBlocks(
          blocks.filter(isImageBlock),
          extractionResults.results.filter((result) => result.blockType === 'image')
        )
      }
      message.traceId = parent?.spanContext().traceId

      void dispatch(_sendMessage(message, blocks, assistant, topic.id))

      setText('')
      setFiles([])
      setTimeoutTimer('sendMessage_1', () => setText(''), 500)
      setTimeoutTimer('sendMessage_2', () => resizeTextArea(), 0)
      // Restore focus to textarea after sending to maintain IME state (fcitx5 issue)
      focusTextarea()
    } catch (error) {
      logger.warn('Failed to send message:', error as Error)
      parent?.recordException(error as Error)
    }
  }, [
    assistant,
    topic,
    text,
    mentionedModels,
    files,
    dispatch,
    setText,
    setFiles,
    setTimeoutTimer,
    resizeTextArea,
    focusTextarea,
    imageProvider,
    imageProcessMethod,
    isGenerateImageSupported,
    isVisionSupported,
    t,
    visionModel
  ])

  const tokenCountProps = useMemo(() => {
    if (!config.showTokenCount || estimateTokenCount === undefined || !showInputEstimatedTokens) {
      return undefined
    }

    return {
      estimateTokenCount,
      inputTokenCount: estimateTokenCount,
      contextCount
    }
  }, [config.showTokenCount, contextCount, estimateTokenCount, showInputEstimatedTokens])

  const onPause = useCallback(async () => {
    await pauseMessages()
  }, [pauseMessages])

  const clearTopic = useCallback(async () => {
    if (loading) {
      await onPause()
      await delay(1)
    }

    void EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES, topic)
    focusTextarea()
  }, [focusTextarea, loading, onPause, topic])

  const onNewContext = useCallback(() => {
    if (loading) {
      void onPause()
      return
    }
    void EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }, [loading, onPause])

  const addNewTopic = useCallback(async () => {
    const newTopic = getDefaultTopic(assistant.id)

    await db.topics.add({ id: newTopic.id, messages: [] })

    if (assistant.defaultModel) {
      setModel(assistant.defaultModel)
    }

    addTopic(newTopic)
    setActiveTopic(newTopic)

    setTimeoutTimer('addNewTopic', () => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
  }, [addTopic, assistant.defaultModel, assistant.id, setActiveTopic, setModel, setTimeoutTimer])

  const handleRemoveModel = useCallback(
    (modelToRemove: Model) => {
      setMentionedModels(mentionedModels.filter((current) => current.id !== modelToRemove.id))
    },
    [mentionedModels, setMentionedModels]
  )

  const handleRemoveKnowledgeBase = useCallback(
    (knowledgeBase: KnowledgeBase) => {
      const nextKnowledgeBases = assistant.knowledge_bases?.filter((kb) => kb.id !== knowledgeBase.id)
      updateAssistant({ ...assistant, knowledge_bases: nextKnowledgeBases })
      setSelectedKnowledgeBases(nextKnowledgeBases ?? [])
    },
    [assistant, setSelectedKnowledgeBases, updateAssistant]
  )

  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !textareaIsExpanded
      setExpanded(target)
      focusTextarea()
    },
    [focusTextarea, setExpanded, textareaIsExpanded]
  )

  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      addNewTopic,
      clearTopic,
      onNewContext,
      onTextChange: setText,
      toggleExpanded: handleToggleExpanded
    }
  }, [resizeTextArea, addNewTopic, clearTopic, onNewContext, setText, handleToggleExpanded, actionsRef])

  useShortcut(
    'new_topic',
    () => {
      void addNewTopic()
      void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
      focusTextarea()
    },
    { preventDefault: true, enableOnFormTags: true }
  )

  useShortcut('clear_topic', clearTopic, {
    preventDefault: true,
    enableOnFormTags: true
  })

  useEffect(() => {
    const _setEstimateTokenCount = debounce(setEstimateTokenCount, 100, { leading: false, trailing: true })
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, ({ tokensCount, contextCount }) => {
        _setEstimateTokenCount(tokensCount)
        setContextCount({ current: contextCount.current, max: contextCount.max })
      }),
      ...[EventEmitter.on(EVENT_NAMES.ADD_NEW_TOPIC, addNewTopic)]
    ]

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [addNewTopic])

  useEffect(() => {
    const debouncedEstimate = debounce((value: string) => {
      if (showInputEstimatedTokens) {
        const count = estimateTxtTokens(value) || 0
        setEstimateTokenCount(count)
      }
    }, 500)

    debouncedEstimate(text)
    return () => debouncedEstimate.cancel()
  }, [showInputEstimatedTokens, text])

  useEffect(() => {
    if (!document.querySelector('.topview-fullscreen-container')) {
      focusTextarea()
    }
  }, [
    topic.id,
    assistant.mcpServers,
    assistant.knowledge_bases,
    assistant.enableWebSearch,
    assistant.webSearchProviderId,
    mentionedModels,
    focusTextarea
  ])

  // TODO: Just use assistant.knowledge_bases as selectedKnowledgeBases. context state is overdesigned.
  useEffect(() => {
    setSelectedKnowledgeBases(assistant.knowledge_bases ?? [])
  }, [assistant.knowledge_bases, setSelectedKnowledgeBases])

  useEffect(() => {
    // Disable web search if model doesn't support it
    if (!isWebSearchModel(model) && assistant.enableWebSearch) {
      updateAssistant({ ...assistant, enableWebSearch: false })
    }

    // Clear web search provider if disabled or model has mandatory search
    if (
      assistant.webSearchProviderId &&
      (!WebSearchService.isWebSearchEnabled(assistant.webSearchProviderId) || isMandatoryWebSearchModel(model))
    ) {
      updateAssistant({ ...assistant, webSearchProviderId: undefined })
    }

    // Auto-enable/disable image generation based on model capabilities
    if (isGenerateImageModel(model)) {
      if (isAutoEnableImageGenerationModel(model) && !assistant.enableGenerateImage) {
        updateAssistant({ ...assistant, enableGenerateImage: true })
      }
    } else if (assistant.enableGenerateImage) {
      updateAssistant({ ...assistant, enableGenerateImage: false })
    }
  }, [assistant, model, updateAssistant])

  if (isMultiSelectMode) {
    return null
  }

  // topContent: 所有顶部预览内容
  const topContent = (
    <>
      {selectedKnowledgeBases.length > 0 && (
        <KnowledgeBaseInput
          selectedKnowledgeBases={selectedKnowledgeBases}
          onRemoveKnowledgeBase={handleRemoveKnowledgeBase}
        />
      )}

      {mentionedModels.length > 0 && (
        <MentionModelsInput selectedModels={mentionedModels} onRemoveModel={handleRemoveModel} />
      )}
    </>
  )

  // leftToolbar: 左侧工具栏
  const leftToolbar = config.showTools ? <InputbarTools scope={scope} assistant={assistant} model={model} /> : null

  // rightToolbar: 右侧工具栏
  const rightToolbar = (
    <>
      {tokenCountProps && (
        <TokenCount
          estimateTokenCount={tokenCountProps.estimateTokenCount}
          inputTokenCount={tokenCountProps.inputTokenCount}
          contextCount={tokenCountProps.contextCount}
          onClick={onNewContext}
        />
      )}
    </>
  )

  return (
    <InputbarCore
      scope={scope}
      placeholder={placeholderText}
      text={text}
      onTextChange={setText}
      textareaRef={textareaRef}
      height={customHeight}
      onHeightChange={setCustomHeight}
      resizeTextArea={resizeTextArea}
      focusTextarea={focusTextarea}
      isLoading={loading}
      supportedExts={supportedExts}
      onPause={onPause}
      handleSendMessage={sendMessage}
      leftToolbar={leftToolbar}
      rightToolbar={rightToolbar}
      topContent={topContent}
    />
  )
}

export default Inputbar
