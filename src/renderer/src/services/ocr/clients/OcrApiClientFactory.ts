import { loggerService } from '@logger'
import type { OcrApiProvider } from '@renderer/types'

import type { OcrBaseApiClient } from './OcrBaseApiClient'
import { OcrExampleApiClient } from './OcrExampleApiClient'

const logger = loggerService.withContext('OcrApiClientFactory')

export class OcrApiClientFactory {
  /**
   * Create an ApiClient instance for the given provider
   * 为给定的提供者创建ApiClient实例
   */
  static create(provider: OcrApiProvider): OcrBaseApiClient {
    logger.debug(`Creating ApiClient for provider:`, {
      id: provider.id,
      config: provider.config
    })

    const instance: OcrBaseApiClient = new OcrExampleApiClient(provider)

    return instance
  }
}
