import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import type { WeChatOcrDetectionResult } from '@types'
import { app } from 'electron'

const logger = loggerService.withContext('WeChatOcrDetectionService')

const exists = (value?: string) => !!value && fs.existsSync(value)

const getUserProfileCandidates = () => {
  const candidates = new Set<string>()
  if (process.env.USERPROFILE) candidates.add(process.env.USERPROFILE)
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    candidates.add(path.join(process.env.HOMEDRIVE, process.env.HOMEPATH))
  }
  return [...candidates]
}

const getWechat3BinaryCandidates = () =>
  getUserProfileCandidates().map((profile) =>
    path.join(profile, 'AppData', 'Roaming', 'Tencent', 'WeChat', 'XPlugin', 'Plugins', 'WeChatOCR')
  )

const getWechat4BinaryCandidates = () =>
  getUserProfileCandidates().map((profile) =>
    path.join(profile, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'XPlugin', 'plugins', 'WeChatOcr')
  )

const getWechatRuntimeCandidates = () => [
  'C:\\Program Files\\Tencent\\Weixin',
  'C:\\Program Files\\Tencent\\WeChat',
  'C:\\Program Files (x86)\\Tencent\\WeChat'
]

const getWcocrDllCandidates = () => [
  path.join(process.cwd(), 'resources', 'wechat-ocr', 'wcocr.dll'),
  path.join(process.cwd(), 'wx-ocr', 'wechat-ocr', 'vs.proj', 'x64', 'Release', 'wcocr.dll'),
  path.join(process.resourcesPath, 'resources', 'wechat-ocr', 'wcocr.dll'),
  path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'wechat-ocr', 'wcocr.dll'),
  path.join(app.getAppPath(), 'resources', 'wechat-ocr', 'wcocr.dll'),
  path.join(app.getAppPath().replace(/\.asar$/, '.asar.unpacked'), 'resources', 'wechat-ocr', 'wcocr.dll')
]

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

export class WeChatOcrDetectionService {
  detect(): WeChatOcrDetectionResult {
    if (!isWin) {
      return {
        installed: false,
        available: false,
        reason: 'wechat_ocr.only_supported_on_windows'
      }
    }

    const wechat4BinaryPath = getWechat4BinaryCandidates()
      .map((candidate) => findDeepestExistingFile(candidate, 'wxocr.dll'))
      .find(Boolean)
    const wechat3BinaryPath = getWechat3BinaryCandidates()
      .map((candidate) => findDeepestExistingFile(candidate, 'WeChatOCR.exe'))
      .find(Boolean)

    const runtimePath = getWechatRuntimeCandidates().map(findExistingDirectory).find(Boolean)
    const binaryPath = wechat4BinaryPath ?? wechat3BinaryPath
    const wcocrDllPath = getWcocrDllCandidates().find(exists)

    if (!runtimePath && !binaryPath && !wcocrDllPath) {
      return {
        installed: false,
        available: false,
        reason: 'wechat_ocr.not_detected'
      }
    }

    const installed = !!runtimePath
    const available = !!runtimePath && !!binaryPath && !!wcocrDllPath
    const detectedVersion = wechat4BinaryPath ? '4.x' : wechat3BinaryPath ? '3.x' : undefined

    const result: WeChatOcrDetectionResult = {
      installed,
      available,
      wechatInstallPath: runtimePath,
      wechatOcrBinaryPath: binaryPath,
      wcocrDllPath,
      detectedVersion,
      reason: available ? undefined : !wcocrDllPath ? 'wechat_ocr.bridge_missing' : 'wechat_ocr.component_missing'
    }

    logger.info('Detected WeChat OCR availability', result)
    return result
  }
}

export const weChatOcrDetectionService = new WeChatOcrDetectionService()
