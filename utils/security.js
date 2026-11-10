// ============================================================
// 图片内容安全检测（接入微信官方 security.imgSecCheck 云函数）
// 选图后、进入处理流程前统一调用：
//   - 通过：resolve(true)，继续原有处理流程
//   - 违规：reject({ risky: true })，提示用户图片含违规内容并中断（不重试）
//   - 检测服务不可用：自动重试 1 次，仍失败才 reject({ unavailable: true, errCode, errMsg })
// 加固说明：
//   1. imgSecCheck 限制图片 ≤1MB、尺寸 ≤750×1334，先在本地压小缩略图再送检
//   2. 【关键】wx.cloud.callFunction 的 data 上限只有 100KB（官方明确：要求小于 100K），
//      base64 又会把体积放大 1.33 倍 → 送检缩略图的 base64 必须控制在 90KB 字符内。
//      原先按"1MB 上限"设计是错的，750px/0.7 的缩略图 base64 常达 300KB，必然被拦。
//   3. 阶梯缩略图：520/0.5 → 440/0.45 → 380/0.4 → 320/0.35，哪档进预算用哪档；
//      若云侧仍报超限（预算判断失准），自动降到最后最小档重试一次
//   4. 同一张图（同 path）的"安全"结论会话内缓存，不重复送检、省调用额度
//   5. 云函数返回的 errCode/errMsg 全程透传并打印控制台，"检测不可用"可定位真实原因
//   6. 全链路 12s 超时兜底：任何环节卡死（如缩略图解码不回调）不会让 loading 永久挂起
//   7. risky / 45009 / 请求体超限不重试：确定性失败，重试只会浪费往返
// ============================================================

const CALL_TIMEOUT_MS = 12000  // 单次完整检测（缩略图 + 云函数）的超时上限
const RETRY_DELAY_MS = 1000    // 首次失败后的重试间隔
const CACHE_MAX = 50           // 会话级缓存上限，防止内存无限增长

// 阶梯缩略图：callFunction 的 data 硬上限 100KB（文本请求体），base64 再放大 1.33 倍，
// 所以这里的预算按"base64 字符数"算，从清晰到小逐档试，进预算即停。
// 依据：imgSecCheck 自身也是把图缩到 750×1334 内再识别，520px 长边对检出率无实质影响。
const THUMB_PLANS = [
  { edge: 520, quality: 0.5 },   // 首选：绝大多数照片 base64 落在 60-85KB
  { edge: 440, quality: 0.45 },
  { edge: 380, quality: 0.4 },
  { edge: 320, quality: 0.35 }   // 兜底：约 20-30KB，纹理极复杂的图也稳过
]
const B64_BUDGET = 90 * 1024      // base64 字符数预算，给 100KB 上限留 10KB 给 JSON 包装
const B64_HARD_LIMIT = 100 * 1024 // 超过 100KB 必然被网关拦下，本地直接判失败，不发无谓请求

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

// 读取图片宽高（失败按不可用处理）
function getImageInfoP(path) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: path,
      success: resolve,
      fail: () => reject({ unavailable: true, reason: 'get_image_info' })
    })
  })
}

// 按指定尺寸/质量把临时图片缩成小图，返回 base64（jpeg）
function makeThumbBase64(path, info, maxEdge, quality) {
  return new Promise((resolve, reject) => {
    let w = info.width
    let h = info.height
    const scale = Math.min(1, maxEdge / Math.max(w, h))
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
        quality: quality,
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
    // callFunction 本身失败：冷启动超时、弱网、云开发环境异常、请求体超限
    const msg = (err && err.errMsg) || String(err)
    console.error('[security] 云函数调用失败:', msg, 'base64 长度:', thumb.base64.length)
    // 请求体超限是确定性失败，重试只会浪费一次往返
    if (msg.indexOf('exceed max size') >= 0) {
      throw { unavailable: true, noRetry: true, reason: 'payload_too_large', errMsg: msg }
    }
    throw { unavailable: true, reason: 'cloud_call', errMsg: msg }
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

// 单次完整检测：阶梯缩略图 + 云函数，整体受超时保护
async function checkOnce(path) {
  return withTimeout((async () => {
    const info = await getImageInfoP(path)

    // 从清晰到小逐档生成，base64 进预算就停（多数图第一档即命中，只渲染一次画布）
    let thumb = null
    let usedPlan = null
    for (let i = 0; i < THUMB_PLANS.length; i++) {
      const plan = THUMB_PLANS[i]
      thumb = await makeThumbBase64(path, info, plan.edge, plan.quality)
      usedPlan = plan
      if (thumb.base64.length <= B64_BUDGET) break
    }

    // 最小档仍超 100KB：发出去必被网关拦，本地直接判失败（实际几乎不会触发）
    if (thumb.base64.length > B64_HARD_LIMIT) {
      console.error('[security] 缩略图过大，已放弃送检, base64 长度:', thumb.base64.length)
      throw { unavailable: true, noRetry: true, reason: 'thumb_too_large', size: thumb.base64.length }
    }

    console.log('[security] 送检缩略图:', `${usedPlan.edge}px/q${usedPlan.quality}`, 'base64 长度:', thumb.base64.length)

    try {
      return await callCloud(thumb)
    } catch (e) {
      // 云侧仍判超限（说明真实上限比 90KB 预算更紧）：降到最小档再试一次
      if (e && e.reason === 'payload_too_large') {
        const last = THUMB_PLANS[THUMB_PLANS.length - 1]
        if (usedPlan.edge === last.edge) throw e
        const smaller = await makeThumbBase64(path, info, last.edge, last.quality)
        console.warn('[security] 云侧报超限，降最小档重试, base64 长度:', smaller.base64.length)
        return callCloud(smaller)
      }
      throw e
    }
  })(), CALL_TIMEOUT_MS)
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
      // 确定性失败（请求体超限等）：重试必然同样失败，不浪费一次往返
      if (e.noRetry) throw e
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
