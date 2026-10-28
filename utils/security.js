// ============================================================
// 图片内容安全检测（接入微信官方 security.imgSecCheck 云函数）
// 选图后、进入处理流程前统一调用：
//   - 通过：resolve(true)，继续原有处理流程
//   - 违规：reject({ risky: true })，提示用户图片含违规内容并中断
//   - 检测服务不可用：reject({ unavailable: true })，提示稍后重试
// 说明：imgSecCheck 限制图片 ≤1MB、尺寸 ≤750×1334，这里先在本地压一张小缩略图再送检
// ============================================================

const MAX_EDGE = 750

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
            quality: 0.8,
            success: (r) => {
              const fs = wx.getFileSystemManager()
              const base64 = fs.readFileSync(r.tempFilePath, 'base64')
              resolve({ base64, contentType: 'image/jpeg' })
            },
            fail: () => reject({ unavailable: true })
          })
        }
        image.onerror = () => reject({ unavailable: true })
        image.src = path
      },
      fail: () => reject({ unavailable: true })
    })
  })
}

// 检测单张图片是否安全
// resolve(true) = 安全；reject 对象区分 risky（违规）/ unavailable（服务不可用）
async function checkImageSafe(path) {
  let thumb
  try {
    thumb = await makeThumbBase64(path)
  } catch (e) {
    throw e || { unavailable: true }
  }

  let res
  try {
    res = await wx.cloud.callFunction({
      name: 'checkImage',
      data: { base64: thumb.base64, contentType: thumb.contentType }
    })
  } catch (err) {
    throw { unavailable: true }
  }

  const data = (res && res.result) || {}
  if (data.safe) return true
  if (data.risky || data.errCode === 87014) throw { risky: true }
  throw { unavailable: true }
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
