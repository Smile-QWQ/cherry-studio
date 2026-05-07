import { APP_NAME } from '@renderer/config/env'
import { useCallback, useEffect, useState } from 'react'

const ONBOARDING_COMPLETED_KEY = 'onboarding-completed'
const APP_NAME_KEY = 'onboarding-app-name'

export function useOnboardingState() {
  const currentAppName = APP_NAME
  const [onboardingCompleted, setOnboardingCompleted] = useState(() => {
    const completed = localStorage.getItem(ONBOARDING_COMPLETED_KEY) === 'true'
    const storedAppName = localStorage.getItem(APP_NAME_KEY)

    if (!completed) {
      return false
    }

    return storedAppName === currentAppName
  })

  useEffect(() => {
    if (!onboardingCompleted) {
      localStorage.setItem(APP_NAME_KEY, currentAppName)
    }
  }, [currentAppName, onboardingCompleted])

  const completeOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true')
    localStorage.setItem(APP_NAME_KEY, currentAppName)
    setOnboardingCompleted(true)
  }, [currentAppName])

  return {
    onboardingCompleted,
    completeOnboarding
  }
}
