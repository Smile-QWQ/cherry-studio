import { SuccessTag } from '@renderer/components/Tags/SuccessTag'
import { useOcrProvider, useOcrProviders } from '@renderer/hooks/useOcrProvider'
import { BuiltinOcrProviderIds, isOcrWechatProvider } from '@renderer/types'
import { Alert, Button, Space } from 'antd'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingRow, SettingRowTitle } from '..'

export const OcrWechatSettings = () => {
  const { t } = useTranslation()
  const { provider } = useOcrProvider(BuiltinOcrProviderIds.wechat_ocr)
  const { wechatDetection, refreshWechatDetection } = useOcrProviders()

  if (!isOcrWechatProvider(provider)) {
    throw new Error('Not WeChat OCR provider.')
  }

  const statusText = useMemo(() => {
    if (!wechatDetection) return t('ocr.wechat.detecting', '正在检测')
    if (wechatDetection.available) return t('ocr.wechat.available', '已检测到，可用')
    if (wechatDetection.installed) return t('ocr.wechat.installed_but_unavailable', '已安装，但 OCR 组件不可用')
    return t('ocr.wechat.not_installed', '未检测到微信 OCR')
  }, [t, wechatDetection])

  return (
    <>
      <SettingRow>
        <SettingRowTitle>{t('ocr.wechat.status', '检测状态')}</SettingRowTitle>
        <Space>
          {wechatDetection?.available ? <SuccessTag message={statusText} /> : <span>{statusText}</span>}
          <Button size="small" onClick={() => void refreshWechatDetection()}>
            {t('ocr.wechat.refresh', '重新检测')}
          </Button>
        </Space>
      </SettingRow>
      {wechatDetection?.wechatInstallPath && (
        <SettingRow>
          <SettingRowTitle>{t('ocr.wechat.install_path', '微信安装路径')}</SettingRowTitle>
          <span>{wechatDetection.wechatInstallPath}</span>
        </SettingRow>
      )}
      {wechatDetection?.wechatOcrBinaryPath && (
        <SettingRow>
          <SettingRowTitle>{t('ocr.wechat.ocr_path', 'OCR 组件路径')}</SettingRowTitle>
          <span>{wechatDetection.wechatOcrBinaryPath}</span>
        </SettingRow>
      )}
      {provider.config?.wcocrDllPath && (
        <SettingRow>
          <SettingRowTitle>{t('ocr.wechat.bridge_path', '桥接 DLL 路径')}</SettingRowTitle>
          <span>{provider.config.wcocrDllPath}</span>
        </SettingRow>
      )}
      {wechatDetection?.reason && !wechatDetection.available && (
        <Alert
          type="warning"
          showIcon
          message={t('ocr.wechat.reason', '不可用原因')}
          description={t(wechatDetection.reason, wechatDetection.reason)}
        />
      )}
    </>
  )
}
