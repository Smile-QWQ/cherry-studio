import CherryStudioLogo from '@renderer/assets/images/logo.png'
import { useAllProviders } from '@renderer/hooks/useProvider'
import { useAppStore } from '@renderer/store'
import { Button } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import type { OnboardingStep } from '../OnboardingPage'
import ProviderPopup from './ProviderPopup'

interface WelcomePageProps {
  setStep: (step: OnboardingStep) => void
}

const WelcomePage: FC<WelcomePageProps> = ({ setStep }) => {
  const { t } = useTranslation()
  const providers = useAllProviders()
  const store = useAppStore()

  const handleSelectProvider = async () => {
    await ProviderPopup.show({ providerId: 'deepseek' })
    const hasAvailableProvider = store.getState().llm.providers.some((p) => p.enabled && p.models.length > 0)
    hasAvailableProvider && setStep('select-model')
  }

  const deepseekProvider = providers.find((provider) => provider.id === 'deepseek')

  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        <img src={CherryStudioLogo} alt="Cherry Studio Fork" className="h-16 w-16 rounded-xl" />

        <div className="flex flex-col items-center gap-2">
          <h1 className="m-0 font-semibold text-(--color-text) text-2xl">{t('onboarding.welcome.title')}</h1>
          <p className="m-0 text-(--color-text-2) text-sm">{t('onboarding.welcome.subtitle')}</p>
        </div>

        <div className="mt-2 flex w-100 flex-col gap-3">
          <Button type="primary" size="large" block className="h-12 rounded-lg" onClick={handleSelectProvider}>
            {t('onboarding.welcome.configure_provider')}
          </Button>
        </div>

        <p className="mt-1 text-(--color-text-3) text-xs">
          {t('onboarding.welcome.setup_hint', { provider: deepseekProvider?.name || 'DeepSeek' })}
        </p>
      </div>
    </div>
  )
}

export default WelcomePage
