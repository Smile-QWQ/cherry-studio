import { loggerService } from '@logger'
import { getAttachmentExtractionSourceLabel } from '@renderer/i18n/label'
import type { AttachmentExtractionMessageBlock } from '@renderer/types/newMessage'
import type { TabsProps } from 'antd'
import { Alert, Tabs, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('AttachmentExtractionBlock')

type Props = {
  block: AttachmentExtractionMessageBlock
}

const AttachmentExtractionBlock = ({ block }: Props) => {
  const { t } = useTranslation()
  const [activeKey, setActiveKey] = useState<string>(
    block.defaultSelectedFileId ?? block.items[0]?.fileId ?? block.failed[0]?.fileId ?? ''
  )

  useEffect(() => {
    setActiveKey(block.defaultSelectedFileId ?? block.items[0]?.fileId ?? block.failed[0]?.fileId ?? '')
  }, [block.defaultSelectedFileId, block.failed, block.items])

  const items = useMemo<TabsProps['items']>(() => {
    const successTabs: NonNullable<TabsProps['items']> = block.items.map((item, index) => ({
      key: item.fileId,
      label: (
        <TabLabel>
          <span>{`${index + 1}. ${item.fileName}`}</span>
          {item.truncated && <Tag color="warning">{t('attachment.extraction.truncated', '已截断')}</Tag>}
        </TabLabel>
      ),
      children: (
        <PanelContent>
          <MetaLine>
            <MetaLabel>{t('common.source', '来源')}</MetaLabel>
            <span>{getAttachmentExtractionSourceLabel(item.source)}</span>
          </MetaLine>
          <ResultText>{item.text}</ResultText>
        </PanelContent>
      )
    }))

    const failedTabs: NonNullable<TabsProps['items']> = block.failed.map((item, index) => ({
      key: item.fileId,
      label: (
        <TabLabel>
          <span>{`${block.items.length + index + 1}. ${item.fileName}`}</span>
          <Tag color="error">{t('common.failed', '失败')}</Tag>
        </TabLabel>
      ),
      children: <Alert type="error" message={item.error} showIcon />
    }))

    return [...successTabs, ...failedTabs]
  }, [block.failed, block.items, t])

  if (!items || items.length === 0) {
    logger.warn('AttachmentExtractionBlock rendered without items or failures', { blockId: block.id })
    return null
  }

  return (
    <Container>
      <Header>
        <Typography.Text strong>{t('attachment.extraction.title', '附件提取结果')}</Typography.Text>
        {block.usedVisionFallbackToOcr && (
          <Tag color="gold">{t('attachment.extraction.fallback_to_ocr', '视觉失败后已回退 OCR')}</Tag>
        )}
      </Header>
      <Tabs activeKey={activeKey} items={items} onChange={setActiveKey} size="small" />
    </Container>
  )
}

const Container = styled.div`
  margin: 8px 0 0;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background-soft, rgba(127, 127, 127, 0.04));
`

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
`

const TabLabel = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
`

const PanelContent = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const MetaLine = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-2);
`

const MetaLabel = styled.span`
  color: var(--color-text-3);
`

const ResultText = styled.pre`
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  color: var(--color-text);
`

export default AttachmentExtractionBlock
