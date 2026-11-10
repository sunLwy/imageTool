// ============================================================
// 图片内容安全检测（接入微信官方 security.imgSecCheck 云函数）
// 选图后、进入处理流程前统一调用：
//   - 通过：resolve(true)，继续原有处理流程
//   - 违规：reject({ risky: true })，提示用户图片含违规内容并中断（不重试）
//   - 检测服务不可用：自动重试 1 次，仍失败才 reject({ unavailable: true, errCode, errMsg })
// 加固说明：
//   1. imgSecCheck 限制图片 ≤1MB、尺寸 ≤750×1334，先在本地压小缩略图再送检
//   2. 同一张图（同 path）的"安全"结论会话内缓存，不重复送检、省调用额度
//   3. 云函数返回的 errCode/errMsg 全程透传并打印控制台，"检测不可用"可定位真实原因
//   4. 全链路 12s 超时兜底：任何环节卡死（如缩略图解码不回调）不会让 loading 永久挂起
//   5. 45009（频率/每日额度超限）不重试：重试必然再失败，直接透传错误码
// ============================================================

const MAX_EDGE = 750
const THUMB_QUALITY = 0.7      // 送检缩略图质量：0.7 与 0.8 检出效果无差别，体积更小更稳
const CALL_TIMEOUT_MS = 12000  // 单次完整检测（缩略图 + 云函数）的超时上限
const RETRY_DELAY_MS = 1000    // 首次失败后的重试间隔
const CACHE_MAX = 50           // 会话级缓存上限，防止内存无限增长

const safeCache = new Map()    // path -> true，只缓存"安全"结论

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 给任意 Promise 加超时：卡死时按 unavailable 处理，而不是让 loading 永久挂起
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject({ unavailable: true, reason: 'timeout' }), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

// 把临时图片缩成小缩略图，返回 base64（jpeg）
function makeThumbBase64(path) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: path,
      success: (info) => {
        let w = info.width
        let h = info.height
        const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
        w = Math.max(1, Math.round(w * scale))
        h = Math.max(1, Math.round(h * scale))

        const canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
        const ctx = canvas.getContext('2d')
        const image = canvas.createImage()

        image.onload = () => {
          ctx.drawImage(image, 0, 0, w, h)
          wx.canvasToTempFilePath({
            canvas,
            fileType: 'jpg',
            quality: THUMB_QUALITY,
            success: (r) => {
              // readFileSync 是同步调用，一旦抛异常必须捕获，
              // 否则 Promise 永远 pending，用户会卡死在"安全检测中"的全屏 loading 上
              try {
                const fs = wx.getFileSystemManager()
                const base64 = fs.readFileSync(r.tempFilePath, 'base64')
                if (!base64) {
                  reject({ unavailable: true, reason: 'empty_thumb' })
                  return
                }
                resolve({ base64, contentType: 'image/jpeg' })
              } catch (e) {
                reject({ unavailable: true, reason: 'read_file', errMsg: e && e.message })
              }
            },
            fail: () => reject({ unavailable: true, reason: 'canvas_export' })
          })
        }
        image.onerror = () => reject({ unavailable: true, reason: 'image_decode' })
        image.src = path
      },
      fail: () => reject({ unavailable: true, reason: 'get_image_info' })
    })
  })
}

// 调云函数并解析结果：非违规异常透传 errCode/errMsg，便于真机定位
async function callCloud(thumb) {
  let res
  try {
    res = await wx.cloud.callFunction({
      name: 'checkImage',
      data: { base64: thumb.base64, contentType: thumb.contentType }
    })
  } catch (err) {
    // callFunction 本身失败：冷启动超时、弱网、云开发环境异常
    console.error('[security] 云函数调用失败:', (err && err.errMsg) || err)
    throw { unavailable: true, reason: 'cloud_call', errMsg: err && err.errMsg }
  }

  const data = (res && res.result) || {}
  if (data.safe) return true
  if (data.risky || data.errCode === 87014) throw { risky: true }

  // 其他异常（-1 系统繁忙 / 45009 额度超限等）：透传原始错误码
  console.error('[security] imgSecCheck 返回异常: errCode=', data.errCode, 'errMsg=', data.errMsg)
  throw {
    unavailable: true,
    reason: 'img_sec_check',
    errCode: data.errCode,
    errMsg: data.errMsg
  }
}

// 单次完整检测：缩略图 + 云函数，整体受超时保护
function checkOnce(path) {
  return withTimeout(
    makeThumbBase64(path).then(callCloud),
    CALL_TIMEOUT_MS
  )
}

// 检测单张图片是否安全
// resolve(true) = 安全；reject 对象区分 risky（违规）/ unavailable（服务不可用，含错误详情）
async function checkImageSafe(path) {
  // 同一张图本会话内已检测通过，直接复用结论
  if (safeCache.has(path)) return true

  let lastErr = null
  // 最多尝试 2 次（首次 + 自动重试 1 次）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await checkOnce(path)
      // 只缓存"安全"结论；违规/失败不缓存，避免误判固化
      if (safeCache.size >= CACHE_MAX) {
        safeCache.delete(safeCache.keys().next().value)
      }
      safeCache.set(path, true)
      return true
    } catch (err) {
      const e = err || { unavailable: true }
      // 违规：直接拦截，绝不重试
      if (e.risky) throw e
      // 45009 频率/每日额度超限：重试必然失败，直接抛出
      if (e.errCode === 45009) throw e

      lastErr = e
      if (attempt < 2) await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastErr || { unavailable: true }
}

// 违规提示：检测结果仅提示用户所选择内容含违规信息即可
// index 大于 0 时为批量场景，标注是第几张；0/不传为单张
function showRiskyTip(index) {
  const content = index > 0
    ? `第${index}张图片包含违规内容，无法处理，已取消本次选择`
    : '图片包含违规内容，无法处理，请更换图片'
  wx.showModal({
    title: '提示',
    content,
    showCancel: false,
    confirmText: '我知道了'
  })
}

// 检测服务不可用提示
function showUnavailableTip() {
  wx.showModal({
    title: '提示',
    content: '内容安全检测暂时不可用，请稍后再试',
    showCancel: false,
    confirmText: '我知道了'
  })
}

module.exports = {
  checkImageSafe,
  showRiskyTip,
  showUnavailableTip
}
