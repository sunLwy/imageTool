// ============================================================
// 官方隐私授权适配 + 保存到相册统一封装（四个工具页共用）
//
// 适配背景：
//   1. 2023-10-17 起所有小程序无条件启用隐私接口校验。涉及
//      wx.chooseMedia（读相册/摄像头）、wx.saveImageToPhotosAlbum（相册仅写入）
//      的调用，需用户在微信侧留有「已同意《用户隐私保护指引》」的记录，
//      否则接口被直接拦截
//   2. 本模块不注册 wx.onNeedPrivacyAuthorization：用户未同意时由微信
//      官方授权弹窗兜底，避免与首页自定义弹窗「双弹」
//   3. 基础库 < 2.32.3 没有这些接口、也没有校验，统一放行
//   4. 后台需已声明《用户隐私保护指引》三项：
//      选中的照片或视频信息 / 相册（仅写入） / 摄像头
// ============================================================

// 查询微信侧隐私授权状态：{ needAuthorization, privacyContractName }
// 查询失败时按「已同意」放行，交由隐私接口自身的拦截兜底
function getPrivacySettingP() {
  return new Promise((resolve) => {
    if (!wx.getPrivacySetting) { resolve({ needAuthorization: false }); return }
    wx.getPrivacySetting({
      success: resolve,
      fail: () => resolve({ needAuthorization: false })
    })
  })
}

// 主动触发一次隐私授权流程：
//   已同意 → 立即 resolve；未同意 → 弹微信官方授权弹窗，拒绝则 reject
function requirePrivacyAuthorizeP() {
  return new Promise((resolve, reject) => {
    if (!wx.requirePrivacyAuthorize) { resolve(); return } // 低版本无校验
    wx.requirePrivacyAuthorize({ success: resolve, fail: reject })
  })
}

// 打开后台配置的《用户隐私保护指引》页面（微信内置页，无需自建页面）
function openPrivacyContract() {
  if (!wx.openPrivacyContract) return
  wx.openPrivacyContract({
    fail: () => wx.showToast({ title: '隐私指引打开失败', icon: 'none' })
  })
}

// 工具页选图前的统一授权 gate：
//   返回 true → 已同意（或低版本无校验），继续原流程
//   返回 false → 用户拒绝/流程异常，已提示，调用方中止
async function ensurePrivacyReady() {
  try {
    await requirePrivacyAuthorizeP()
    return true
  } catch (err) {
    console.warn('[privacy] 授权未通过:', (err && err.errMsg) || err)
    wx.showToast({ title: '需同意隐私协议后才能选择图片', icon: 'none' })
    return false
  }
}

// ============ 保存到相册（替换四个页面各自复制的实现） ============

// 修复：原判断 includes('auth deny') 匹配不到 'fail auth denied' 等变体
function isAlbumAuthDenied(errMsg) {
  const msg = errMsg || ''
  return /auth\s*den(y|ied)|authorize|permission/i.test(msg)
}

// 授权被拒引导（统一弹「去设置」）
function showAlbumAuthGuide() {
  wx.showModal({
    title: '需要相册权限',
    content: '请在设置中允许「保存到相册」',
    confirmText: '去设置',
    success: (r) => { if (r.confirm) wx.openSetting() }
  })
}

// 单张保存（静默版）：resolve 结果字符串，调用方自行决定提示
//   'ok'     保存成功（不 toast）
//   'auth'   授权被拒（已弹引导框，批量场景应立即中止）
//   'cancel' 用户主动取消（不提示）
//   'fail'   其他失败（已 toast）
function saveImageToAlbumP(filePath) {
  return new Promise((resolve) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve('ok'),
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        if (isAlbumAuthDenied(msg)) {
          showAlbumAuthGuide()
          resolve('auth')
        } else if (msg.indexOf('cancel') >= 0) {
          resolve('cancel')
        } else {
          wx.showToast({ title: '保存失败，请重试', icon: 'none' })
          resolve('fail')
        }
      }
    })
  })
}

// 单张保存（带成功 toast）：resolve(true) = 已保存
async function saveImageToAlbum(filePath) {
  const result = await saveImageToAlbumP(filePath)
  if (result === 'ok') {
    wx.showToast({ title: '已保存到相册', icon: 'success' })
    return true
  }
  return false
}

module.exports = {
  getPrivacySettingP,
  requirePrivacyAuthorizeP,
  openPrivacyContract,
  ensurePrivacyReady,
  isAlbumAuthDenied,
  saveImageToAlbumP,
  saveImageToAlbum
}
