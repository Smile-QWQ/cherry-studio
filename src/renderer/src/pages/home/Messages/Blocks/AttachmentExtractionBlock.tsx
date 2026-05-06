import { loggerService } from '@logger'
import { getAttachmentExtractionSourceLabel } from '@renderer/i18n/label'
import type { AttachmentExtractionMessageBlock } from '@renderer/types/newMessage'
import type { CollapseProps, TabsProps } from 'antd'
import { Alert, Collapse, Tabs, Tag, Tooltip, Typography } from 'antd'
import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('AttachmentExtractionBlock')

type Props = {
  block: AttachmentExtractionMessageBlock
}

const AttachmentExtractionBlock = ({ block }: Props) => {
  const { t } = useTranslation()
  const [collapseActiveKey, setCollapseActiveKey] = useState<'attachment-extraction' | ''>('')
  const [activeKey, setActiveKey] = useState<string>(
    block.defaultSelectedFileId ?? block.items[0]?.fileId ?? block.failed[0]?.fileId ?? ''
  )

  useEffect(() => {
    setActiveKey(block.defaultSelectedFileId ?? block.items[0]?.fileId ?? block.failed[0]?.fileId ?? '')
  }, [block.defaultSelectedFileId, block.failed, block.items])

  useEffect(() => {
    setCollapseActiveKey('')
  }, [block.id])

  const items = useMemo<TabsProps['items']>(() => {
    const successTabs: NonNullable<TabsProps['items']> = block.items.map((item, index) => ({
      key: item.fileId,
      label: (
        <TabLabel>
          <Tooltip title={item.fileName}>
            <FileNameText>{`${index + 1}. ${item.fileName}`}</FileNameText>
          </Tooltip>
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
          <Tooltip title={item.fileName}>
            <FileNameText>{`${block.items.length + index + 1}. ${item.fileName}`}</FileNameText>
          </Tooltip>
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

  const collapseItems: CollapseProps['items'] = [
    {
      key: 'attachment-extraction',
      label: (
        <Header>
          <HeaderLeft>
            <ChevronRight
              size={16}
              style={{
                transform: collapseActiveKey === 'attachment-extraction' ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease'
              }}
            />
            <Typography.Text strong>{t('attachment.extraction.title', '附件提取结果')}</Typography.Text>
          </HeaderLeft>
          <HeaderMeta>
            {block.items.length > 0 && (
              <Tag bordered={false} color="default">
                {t('common.success', '成功')} {block.items.length}
              </Tag>
            )}
            {block.failed.length > 0 && (
              <Tag bordered={false} color="error">
                {t('common.failed', '失败')} {block.failed.length}
              </Tag>
            )}
            {block.usedVisionFallbackToOcr && (
              <Tag color="gold">{t('attachment.extraction.fallback_to_ocr', '视觉失败后已回退 OCR')}</Tag>
            )}
          </HeaderMeta>
        </Header>
      ),
      children: <Tabs activeKey={activeKey} items={items} onChange={setActiveKey} size="small" />,
      showArrow: false
    }
  ]

  return (
    <Container>
      <CollapseContainer
        activeKey={collapseActiveKey}
        size="small"
        ghost
        onChange={() => setCollapseActiveKey((key) => (key === 'attachment-extraction' ? '' : 'attachment-extraction'))}
        items={collapseItems}
      />
    </Container>
  )
}

const Container = styled.div`
  margin: 8px 0 0;
`

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
`

const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const HeaderMeta = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
`

const TabLabel = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  min-width: 0;
`

const FileNameText = styled.span`
  display: inline-block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  max-height: 320px;
  overflow: auto;
  padding-right: 4px;
`

const CollapseContainer = styled(Collapse)`
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background-soft, rgba(127, 127, 127, 0.04));

  .ant-collapse-item {
    border-bottom: none;
  }

  .ant-collapse-header {
    padding: 12px !important;
  }

  .ant-collapse-content-box {
    padding: 0 12px 12px !important;
  }
`

export default AttachmentExtractionBlock
