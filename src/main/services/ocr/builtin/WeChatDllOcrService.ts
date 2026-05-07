import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import type { ImageFileMetadata, OcrResult, OcrWechatConfig, SupportedOcrFile } from '@types'
import { isImageFileMetadata } from '@types'
import { Mutex } from 'async-mutex'
import { app } from 'electron'
import koffi from 'koffi'

import { OcrBaseService } from './OcrBaseService'

const logger = loggerService.withContext('WeChatDllOcrService')

const CALLBACK_PROTO = koffi.proto('void WeChatOcrResultCallback(const char *dt)')

const exists = (value?: string) => !!value && fs.existsSync(value)

const getUserProfileCandidates = () => {
  const candidates = new Set<string>()
  if (process.env.USERPROFILE) candidates.add(process.env.USERPROFILE)
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    candidates.add(path.join(process.env.HOMEDRIVE, process.env.HOMEPATH))
  }
  return [...candidates]
}

const findDeepestExistingFile = (rootDir: string, fileName: string): string | undefined => {
  if (!exists(rootDir)) return undefined
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()

  for (const version of versions) {
    const candidate = path.join(rootDir, version, 'extracted', fileName)
    if (exists(candidate)) {
      return candidate
    }
  }
  return undefined
}

const findExistingDirectory = (rootDir: string): string | undefined => {
  if (!exists(rootDir)) return undefined
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const version of versions) {
    const candidate = path.join(rootDir, version)
    if (exists(candidate)) {
      return candidate
    }
  }
  return undefined
}

const detectWechatBinaryPath = () => {
  const wechat4Candidates = getUserProfileCandidates().map((profile) =>
    path.join(profile, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'XPlugin', 'plugins', 'WeChatOcr')
  )
  const wechat3Candidates = getUserProfileCandidates().map((profile) =>
    path.join(profile, 'AppData', 'Roaming', 'Tencent', 'WeChat', 'XPlugin', 'Plugins', 'WeChatOCR')
  )

  return (
    wechat4Candidates.map((candidate) => findDeepestExistingFile(candidate, 'wxocr.dll')).find(Boolean) ||
    wechat3Candidates.map((candidate) => findDeepestExistingFile(candidate, 'WeChatOCR.exe')).find(Boolean)
  )
}

const detectWechatRuntimePath = () => {
  const runtimeCandidates = [
    'C:\\Program Files\\Tencent\\Weixin',
    'C:\\Program Files\\Tencent\\WeChat',
    'C:\\Program Files (x86)\\Tencent\\WeChat'
  ]

  return runtimeCandidates.map(findExistingDirectory).find(Boolean)
}

const detectWcocrDllPath = () => {
  const candidates = [
    path.join(process.cwd(), 'resources', 'wechat-ocr', 'wcocr.dll'),
    path.join(process.cwd(), 'wx-ocr', 'wechat-ocr', 'vs.proj', 'x64', 'Release', 'wcocr.dll'),
    path.join(process.resourcesPath, 'resources', 'wechat-ocr', 'wcocr.dll'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'wechat-ocr', 'wcocr.dll'),
    path.join(app.getAppPath(), 'resources', 'wechat-ocr', 'wcocr.dll'),
    path.join(app.getAppPath().replace(/\.asar$/, '.asar.unpacked'), 'resources', 'wechat-ocr', 'wcocr.dll')
  ]

  return candidates.find(exists)
}

type WechatOcrExports = {
  wechatOcr: (ocrExe: string, wechatDir: string, imagePath: string, callback: unknown) => boolean
  stopOcr: () => void
}

export class WeChatDllOcrService extends OcrBaseService {
  private readonly mutex = new Mutex()
  private exports: WechatOcrExports | null = null
  private loadedDllPath?: string

  private loadExports(dllPath: string): WechatOcrExports {
    if (this.exports && this.loadedDllPath === dllPath) {
      return this.exports
    }

    const lib = koffi.load(dllPath)
    const exports: WechatOcrExports = {
      wechatOcr: lib.func('wechat_ocr', 'bool', ['str16', 'str16', 'str', koffi.pointer(CALLBACK_PROTO)]),
      stopOcr: lib.func('void stop_ocr()')
    }

    this.exports = exports
    this.loadedDllPath = dllPath
    return exports
  }

  private resolvePaths(options?: OcrWechatConfig) {
    const dllPath = options?.wcocrDllPath || detectWcocrDllPath()
    const wechatOcrBinaryPath = options?.wechatOcrBinaryPath || detectWechatBinaryPath()
    const wechatInstallPath = options?.wechatInstallPath || detectWechatRuntimePath()

    if (!dllPath) {
      throw new Error('WeChat OCR bridge DLL not found')
    }
    if (!wechatOcrBinaryPath) {
      throw new Error('WeChat OCR binary not found')
    }
    if (!wechatInstallPath) {
      throw new Error('WeChat runtime directory not found')
    }

    return {
      dllPath,
      wechatOcrBinaryPath,
      wechatInstallPath
    }
  }

  private async imageOcr(file: ImageFileMetadata, options?: OcrWechatConfig): Promise<OcrResult> {
    if (!isWin) {
      throw new Error('WeChat OCR is only supported on Windows')
    }

    const release = await this.mutex.acquire()
    try {
      const { dllPath, wechatInstallPath, wechatOcrBinaryPath } = this.resolvePaths(options)
      const exports = this.loadExports(dllPath)

      let resultText = ''
      const callback = koffi.register((result: string) => {
        resultText = result
      }, koffi.pointer(CALLBACK_PROTO))

      try {
        const ok = exports.wechatOcr(wechatOcrBinaryPath, wechatInstallPath, file.path, callback)
        if (!ok) {
          throw new Error('wechat_ocr returned false')
        }
      } finally {
        try {
          exports.stopOcr()
        } catch (error) {
          logger.warn('Failed to stop WeChat OCR instance cleanly', error as Error)
        }
        koffi.unregister(callback)
      }

      if (!resultText) {
        throw new Error('wechat_ocr returned empty result')
      }

      const payload = JSON.parse(resultText) as {
        error?: string
        ocr_response?: Array<{ text?: string }>
      }

      if (payload.error) {
        throw new Error(payload.error)
      }

      const text =
        payload.ocr_response
          ?.map((item) => item.text?.trim())
          .filter(Boolean)
          .join('\n') ?? ''

      return { text }
    } finally {
      release()
    }
  }

  public ocr = async (file: SupportedOcrFile, options?: OcrWechatConfig): Promise<OcrResult> => {
    if (!isImageFileMetadata(file)) {
      throw new Error('Only image files are supported currently')
    }
    return this.imageOcr(file, options)
  }
}

export const weChatDllOcrService = new WeChatDllOcrService()
