import { loggerService } from '@logger'
import { getAnthropicReasoningParams } from '@renderer/aiCore/utils/reasoning'
import type { QuickPanelTriggerInfo } from '@renderer/components/QuickPanel'
import { QuickPanelReservedSymbol, useQuickPanel } from '@renderer/components/QuickPanel'
import { isGenerateImageModel, isVisionModel } from '@renderer/config/models'
import { useAgent } from '@renderer/hooks/agents/useAgent'
import { useSession } from '@renderer/hooks/agents/useSession'
import { useDefaultModel } from '@renderer/hooks/useAssistant'
import { useAttachmentPreprocess } from '@renderer/hooks/useAttachmentPreprocess'
import { useInputText } from '@renderer/hooks/useInputText'
import { selectNewTopicLoading } from '@renderer/hooks/useMessageOperations'
import { getModel } from '@renderer/hooks/useModel'
import { useOcrProviders } from '@renderer/hooks/useOcrProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { useTimer } from '@renderer/hooks/useTimer'
import { InputbarCore } from '@renderer/pages/home/Inputbar/components/InputbarCore'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import InputbarTools from '@renderer/pages/home/Inputbar/InputbarTools'
import { getInputbarConfig } from '@renderer/pages/home/Inputbar/registry'
import type { ToolContext } from '@renderer/pages/home/Inputbar/types'
import { TopicType } from '@renderer/pages/home/Inputbar/types'
import { isSoulModeEnabled } from '@renderer/pages/settings/AgentSettings/shared'
import {
  applyAttachmentProcessedResultsToBlocks,
  hasVisualExtractionResult
} from '@renderer/services/AttachmentTextExtractionService'
import { CacheService } from '@renderer/services/CacheService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { getUserMessage } from '@renderer/services/MessagesService'
import { pauseTrace } from '@renderer/services/SpanManagerService'
import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import { sendMessage as dispatchSendMessage } from '@renderer/store/thunk/messageThunk'
import type { Assistant, FileMetadata, ThinkingOption, Topic } from '@renderer/types'
import { abortCompletion } from '@renderer/utils/abortController'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('AgentSessionInputbar')

const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

const getAgentDraftCacheKey = (agentId: string) => `agent-session-draft-${agentId}`
const isAttachmentBlock = (block: { type: string }) => block.type === 'image'

type Props = {
  agentId: string
  sessionId: string
}

const AgentSessionInputbar = ({ agentId, sessionId }: Props) => {
  const { session } = useSession(agentId, sessionId)
  // FIXME: 不应该使用ref将action传到context提供给tool，权宜之计
  const actionsRef = useRef({
    resizeTextArea: () => {},
    // oxlint-disable-next-line no-unused-vars
    onTextChange: (_updater: React.SetStateAction<string> | ((prev: string) => string)) => {},
    toggleExpanded: () => {}
  })

  // Create assistant stub with session data
  const assistantStub = useMemo<Assistant | null>(() => {
    if (!session) return null

    // Extract model info
    const [providerId, actualModelId] = session.model?.split(':') ?? [undefined, undefined]
    const actualModel = actualModelId ? getModel(actualModelId, providerId) : undefined

    return {
      id: session.agent_id ?? agentId,
      name: session.name ?? 'Agent Session',
      prompt: session.instructions ?? '',
      topics: [],
      type: 'agent-session',
      model: actualModel,
      defaultModel: actualModel,
      tags: [],
      enableWebSearch: false
    } satisfies Assistant
  }, [session, agentId])

  // Prepare session data for tools
  const sessionData = useMemo(() => {
    if (!session) return undefined
    return {
      agentId,
      sessionId,
      slashCommands: session.slash_commands,
      tools: session.tools,
      accessiblePaths: session.accessible_paths ?? []
    }
  }, [session, agentId, sessionId])

  const initialState = useMemo(
    () => ({
      mentionedModels: [],
      selectedKnowledgeBases: [],
      files: [] as FileMetadata[],
      isExpanded: false
    }),
    []
  )

  if (!assistantStub) {
    return null // Wait for session to load
  }

  return (
    <InputbarToolsProvider
      initialState={initialState}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        // Agent Session specific actions
        addNewTopic: () => {},
        clearTopic: () => {},
        onNewContext: () => {},
        toggleExpanded: () => actionsRef.current.toggleExpanded()
      }}>
      <AgentSessionInputbarInner
        assistant={assistantStub}
        agentId={agentId}
        sessionId={sessionId}
        sessionData={sessionData}
        actionsRef={actionsRef}
      />
    </InputbarToolsProvider>
  )
}

interface InnerProps {
  assistant: Assistant
  agentId: string
  sessionId: string
  sessionData?: ToolContext['session']
  actionsRef: React.MutableRefObject<{
    resizeTextArea: () => void
    onTextChange: (updater: React.SetStateAction<string> | ((prev: string) => string)) => void
    toggleExpanded: (nextState?: boolean) => void
  }>
}

const AgentSessionInputbarInner: FC<InnerProps> = ({ assistant, agentId, sessionId, sessionData, actionsRef }) => {
  const { agent: agentBase } = useAgent(agentId)
  const scope = TopicType.Session
  const config = getInputbarConfig(scope)

  // Use shared hooks for text and textarea management with draft persistence
  const draftCacheKey = getAgentDraftCacheKey(agentId)
  const {
    text,
    setText,
    isEmpty: inputEmpty
  } = useInputText({
    initialValue: CacheService.get<string>(draftCacheKey) ?? '',
    onChange: (value) => CacheService.set(draftCacheKey, value, DRAFT_CACHE_TTL)
  })
  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    isExpanded: textareaIsExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({ maxHeight: 500, minHeight: 30 })
  const {
    sendMessageShortcut,
    apiServer,
    imageProcessMethod,
    attachmentExtractionLimitMode,
    attachmentExtractionMaxFileChars,
    attachmentExtractionMaxTotalChars
  } = useSettings()
  const { visionModel } = useDefaultModel()
  const { imageProvider } = useOcrProviders()

  const { t } = useTranslation()
  const quickPanel = useQuickPanel()

  const [reasoningEffort, setReasoningEffort] = useState<ThinkingOption>('default')

  const { files } = useInputbarToolsState()
  const { toolsRegistry, setIsExpanded, setFiles } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const { setTimeoutTimer } = useTimer()
  const dispatch = useAppDispatch()
  const sessionTopicId = buildAgentSessionTopicId(sessionId)
  const topicMessages = useAppSelector((state) => selectMessagesForTopic(state, sessionTopicId))
  const loading = useAppSelector((state) => selectNewTopicLoading(state, sessionTopicId))

  // Calculate vision and image generation support
  const isVisionAssistant = useMemo(() => (assistant.model ? isVisionModel(assistant.model) : false), [assistant.model])
  const isGenerateImageAssistant = useMemo(
    () => (assistant.model ? isGenerateImageModel(assistant.model) : false),
    [assistant.model]
  )

  // Agent sessions don't support model mentions yet, so we only check the assistant's model
  const canAddImageFile = useMemo(() => {
    // Agent Session 与 Home Chat 对齐：允许先添加图片，
    // 具体走原生传图还是发送前抽取，取决于当前会话模型能力。
    return true
  }, [])

  const canAddTextFile = useMemo(() => {
    return isVisionAssistant || (!isVisionAssistant && !isGenerateImageAssistant)
  }, [isVisionAssistant, isGenerateImageAssistant])

  const shouldPreprocessAttachments = useMemo(
    () => !isVisionAssistant && !isGenerateImageAssistant,
    [isGenerateImageAssistant, isVisionAssistant]
  )

  // Update the couldAddImageFile state when the model changes
  useEffect(() => {
    setCouldAddImageFile(canAddImageFile)
  }, [canAddImageFile, setCouldAddImageFile])

  const syncExpandedState = useCallback(
    (expanded: boolean) => {
      setExpanded(expanded)
      setIsExpanded(expanded)
    },
    [setExpanded, setIsExpanded]
  )
  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !textareaIsExpanded
      syncExpandedState(target)
      focusTextarea()
    },
    [focusTextarea, syncExpandedState, textareaIsExpanded]
  )

  // Update actionsRef for InputbarTools
  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      onTextChange: setText,
      toggleExpanded: handleToggleExpanded
    }
  }, [resizeTextArea, setText, actionsRef, handleToggleExpanded])

  const rootTriggerHandlerRef = useRef<((payload?: unknown) => void) | undefined>(undefined)

  // Update handler logic when dependencies change
  // For Agent Session, we directly trigger SlashCommands panel instead of Root menu
  useEffect(() => {
    rootTriggerHandlerRef.current = (payload) => {
      const slashCommands = sessionData?.slashCommands || []
      const triggerInfo = (payload ?? {}) as QuickPanelTriggerInfo

      if (slashCommands.length === 0) {
        quickPanel.open({
          title: t('chat.input.slash_commands.title'),
          symbol: QuickPanelReservedSymbol.SlashCommands,
          triggerInfo,
          list: [
            {
              label: t('chat.input.slash_commands.empty', 'No slash commands available'),
              description: '',
              icon: null,
              disabled: true,
              action: () => {}
            }
          ]
        })
        return
      }

      quickPanel.open({
        title: t('chat.input.slash_commands.title'),
        symbol: QuickPanelReservedSymbol.SlashCommands,
        triggerInfo,
        list: slashCommands.map((cmd) => ({
          label: cmd.command,
          description: cmd.description || '',
          icon: null,
          filterText: `${cmd.command} ${cmd.description || ''}`,
          action: () => {
            // Insert command into textarea
            setText((prev: string) => {
              const textArea = document.querySelector('.inputbar textarea') as HTMLTextAreaElement | null
              if (!textArea) {
                return prev + ' ' + cmd.command
              }

              const cursorPosition = textArea.selectionStart || 0
              const textBeforeCursor = prev.slice(0, cursorPosition)
              const lastSlashIndex = textBeforeCursor.lastIndexOf('/')

              if (lastSlashIndex !== -1 && cursorPosition > lastSlashIndex) {
                // Replace from '/' to cursor with command
                const newText = prev.slice(0, lastSlashIndex) + cmd.command + ' ' + prev.slice(cursorPosition)
                const newCursorPos = lastSlashIndex + cmd.command.length + 1

                setTimeout(() => {
                  if (textArea) {
                    textArea.focus()
                    textArea.setSelectionRange(newCursorPos, newCursorPos)
                  }
                }, 0)

                return newText
              }

              // No '/' found, just insert at cursor
              const newText = prev.slice(0, cursorPosition) + cmd.command + ' ' + prev.slice(cursorPosition)
              const newCursorPos = cursorPosition + cmd.command.length + 1

              setTimeout(() => {
                if (textArea) {
                  textArea.focus()
                  textArea.setSelectionRange(newCursorPos, newCursorPos)
                }
              }, 0)

              return newText
            })
          }
        }))
      })
    }
  }, [sessionData, quickPanel, t, setText])

  // Register the trigger handler (only once)
  useEffect(() => {
    if (!config.enableQuickPanel) {
      return
    }

    const disposeRootTrigger = toolsRegistry.registerTrigger(
      'agent-session-root',
      QuickPanelReservedSymbol.Root,
      (payload) => rootTriggerHandlerRef.current?.(payload)
    )

    return () => {
      disposeRootTrigger()
    }
  }, [config.enableQuickPanel, toolsRegistry])

  const sendDisabled = (inputEmpty && files.length === 0) || !apiServer.enabled

  const { attachmentPreprocessSnapshot, attachmentPreprocessStates, removeAttachment } = useAttachmentPreprocess({
    files,
    setFiles,
    enabled: shouldPreprocessAttachments,
    allowDocuments: canAddTextFile,
    imageProcessMethod,
    imageProvider,
    visionModel,
    attachmentExtractionLimitMode,
    attachmentExtractionMaxFileChars,
    attachmentExtractionMaxTotalChars
  })

  const streamingAskIds = useMemo(() => {
    if (!topicMessages) {
      return []
    }

    const askIdSet = new Set<string>()
    for (const message of topicMessages) {
      if (!message) continue
      if (message.status === 'processing' || message.status === 'pending') {
        if (message.askId) {
          askIdSet.add(message.askId)
        } else if (message.id) {
          askIdSet.add(message.id)
        }
      }
    }

    return Array.from(askIdSet)
  }, [topicMessages])

  const canAbort = loading && streamingAskIds.length > 0

  const abortAgentSession = useCallback(async () => {
    if (!streamingAskIds.length) {
      logger.debug('No active agent session streams to abort', { sessionTopicId })
      return
    }

    logger.info('Aborting agent session message generation', {
      sessionTopicId,
      askIds: streamingAskIds
    })

    for (const askId of streamingAskIds) {
      abortCompletion(askId)
    }

    void pauseTrace(sessionTopicId)
    dispatch(newMessagesActions.setTopicLoading({ topicId: sessionTopicId, loading: false }))
  }, [dispatch, sessionTopicId, streamingAskIds])

  const sendMessage = useCallback(async () => {
    if (sendDisabled) {
      return
    }

    logger.info('Starting to send message')

    try {
      const uploadedFiles = shouldPreprocessAttachments
        ? await Promise.all(files.map((file) => (FileManager.isStoredFile(file) ? file : FileManager.uploadFile(file))))
        : await FileManager.uploadFiles(files)
      if (shouldPreprocessAttachments) {
        if (attachmentPreprocessSnapshot.hasPendingProcessableAttachments) {
          window.toast.warning(t('attachment.extraction.wait_for_completion', '请等待附件解析完成后再发送'))
          return
        }

        if (
          !text.trim() &&
          attachmentPreprocessSnapshot.hasProcessableAttachments &&
          !attachmentPreprocessSnapshot.hasAnySuccess
        ) {
          window.toast.error(t('chat.input.file_error'))
          return
        }

        if (attachmentPreprocessSnapshot.usedVisionFallbackToOcr) {
          window.toast.warning(t('message.error.file.vision.model_fallback_to_ocr'))
        }
      }

      const topicStub: Topic = {
        // Agent Session 这里没有现成 Topic 实体可直接复用，
        // 但 getUserMessage 依赖 topic/assistant 组合来生成标准用户消息结构，
        // 因此构造最小 stub，复用 Home Chat 的 block/message 创建逻辑。
        id: sessionTopicId,
        assistantId: agentId,
        name: sessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
      }

      const { message: userMessage, blocks: userMessageBlocks } = getUserMessage({
        assistant: {
          ...assistant,
          id: agentId,
          topics: []
        },
        topic: topicStub,
        content: text,
        files: uploadedFiles,
        attachmentExtraction:
          shouldPreprocessAttachments &&
          (attachmentPreprocessSnapshot.hasAnySuccess || attachmentPreprocessSnapshot.failed.length > 0)
            ? {
                items: attachmentPreprocessSnapshot.items,
                failed: attachmentPreprocessSnapshot.failed,
                totalInjectedChars: attachmentPreprocessSnapshot.totalInjectedChars,
                usedVisionFallbackToOcr: attachmentPreprocessSnapshot.usedVisionFallbackToOcr
              }
            : undefined,
        usage: await estimateUserPromptUsage({
          content: text,
          files: uploadedFiles
        })
      })

      userMessage.model = assistant.model
      userMessage.modelId = assistant.model?.id
      if (shouldPreprocessAttachments && hasVisualExtractionResult(attachmentPreprocessSnapshot)) {
        // 和 Home Chat 保持一致：只给图片 block 写 processedResult，
        // 同时保留原始附件 block，不再退化为只发路径字符串。
        applyAttachmentProcessedResultsToBlocks(
          userMessageBlocks.filter(isAttachmentBlock),
          attachmentPreprocessSnapshot.items.filter((result) => result.blockType === 'image')
        )
      }

      const thinkingParams = assistant.model
        ? getAnthropicReasoningParams(
            { ...assistant, settings: { ...assistant.settings, reasoning_effort: reasoningEffort } },
            assistant.model
          )
        : {}

      void dispatch(
        dispatchSendMessage(userMessage, userMessageBlocks, assistant, sessionTopicId, {
          agentId,
          sessionId,
          ...thinkingParams
        })
      )

      // Emit event to trigger scroll to bottom in AgentSessionMessages
      void EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: sessionTopicId })

      // Clear text and files after successful send (draft is cleared automatically via onChange)
      setText('')
      setFiles([])
      setTimeoutTimer('agentSession_sendMessage', () => setText(''), 500)
      // Restore focus to textarea after sending to maintain IME state (fcitx5 issue)
      focusTextarea()
    } catch (error) {
      logger.warn('Failed to send message:', error as Error)
    }
  }, [
    sendDisabled,
    agentId,
    dispatch,
    assistant,
    sessionId,
    sessionTopicId,
    setText,
    setFiles,
    setTimeoutTimer,
    text,
    files,
    focusTextarea,
    reasoningEffort,
    attachmentPreprocessSnapshot,
    shouldPreprocessAttachments,
    t
  ])

  useEffect(() => {
    if (!document.querySelector('.topview-fullscreen-container')) {
      focusTextarea()
    }
  }, [focusTextarea])

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

  const toolsSession = useMemo(() => {
    if (!sessionData) return undefined
    return { ...sessionData, reasoningEffort, onReasoningEffortChange: setReasoningEffort }
  }, [sessionData, reasoningEffort])

  const leftToolbar = useMemo(
    () => (
      <ToolbarGroup>
        {config.showTools && (
          <InputbarTools scope={scope} assistant={assistant} model={assistant.model!} session={toolsSession} />
        )}
      </ToolbarGroup>
    ),
    [config.showTools, scope, assistant, toolsSession]
  )
  const placeholderText = useMemo(() => {
    if (isSoulModeEnabled(agentBase?.configuration)) {
      return t('agent.input.soul_placeholder')
    }
    return t('agent.input.placeholder', {
      key: getSendMessageShortcutLabel(sendMessageShortcut)
    })
  }, [agentBase?.configuration, sendMessageShortcut, t])

  return (
    <InputbarCore
      scope={TopicType.Session}
      text={text}
      onTextChange={setText}
      textareaRef={textareaRef}
      height={customHeight}
      onHeightChange={setCustomHeight}
      resizeTextArea={resizeTextArea}
      focusTextarea={focusTextarea}
      placeholder={placeholderText}
      supportedExts={supportedExts}
      onPause={abortAgentSession}
      isLoading={canAbort}
      handleSendMessage={sendMessage}
      leftToolbar={leftToolbar}
      attachmentPreprocessStates={attachmentPreprocessStates}
      onRemoveAttachment={removeAttachment}
      forceEnableQuickPanelTriggers
    />
  )
}

const ToolbarGroup = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
`

export default AgentSessionInputbar
