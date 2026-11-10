const app = getApp()
const { checkImageSafe, showRiskyTip, showUnavailableTip } = require('../../utils/security')
const { readExifP } = require('../../utils/exif')

// Canvas 重绘的最大边长：超限先等比缩小，避免大图建 48MB+ 位图导致低端机 OOM
const MAX_CANVAS_EDGE = 2560

Page({
  // 转发给好友：落地页统一为首页，用户点开即可看到全部工具
  onShareAppMessage() {
    return {
      title: '图片压缩：按质量或指定大小，HEIC/PNG 也能转 JPG',
      path: '/pages/index/index'
    };
  },

  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: '图片压缩：按质量或指定大小，HEIC/PNG 也能转 JPG'
    };
  },

  data: {
    // 原图
    originalPath: '',
    originalSize: '',
    originalWidth: 0,
    originalHeight: 0,
    originalSizeBytes: 0,

    // 压缩设置
    quality: 60,
    compressMode: 'quality',  // 'quality' 或 'targetSize'
    targetSize: 500,          // 单位KB，目标文件大小
    customSize: '',           // 自定义目标大小（KB）

    // 压缩中
    compressing: false,

    // 压缩结果
    compressedPath: '',
    compressedSize: '',
    compressedWidth: 0,
    compressedHeight: 0,
    compressedSizeBytes: 0,
    savingPercent: 0,

    // 保存中
    saving: false,

    // 每日免费次数（总开关：等UV满1000开通流量主后再改成true）
    enableLimit: false,
    dailyLeft: 999,
    dailyUsed: 0,

    // 广告
    showBanner: false,
    adUnitIds: app.globalData.adUnitIds
  },

  onLoad() {
    this.loadDailyLimit()
    this.initBannerAd()
    this.initRewardedAd()
  },

  // ============ 每日次数（本地存储，按日期重置） ============
  loadDailyLimit() {
    const today = new Date().toDateString()
    const record = wx.getStorageSync('dailyRecord') || {}

    if (record.date !== today) {
      // 新的一天，重置
      record.date = today
      record.used = 0
      wx.setStorageSync('dailyRecord', record)
    }

    const freeLimit = app.globalData.freeDailyLimit
    this.setData({
      dailyUsed: record.used,
      dailyLeft: Math.max(0, freeLimit - record.used)
    })
  },

  consumeDailyLimit() {
    const today = new Date().toDateString()
    const record = wx.getStorageSync('dailyRecord') || {}
    record.used = (record.used || 0) + 1
    wx.setStorageSync('dailyRecord', record)

    const freeLimit = app.globalData.freeDailyLimit
    this.setData({
      dailyUsed: record.used,
      dailyLeft: Math.max(0, freeLimit - record.used)
    })
  },

  // ============ 选图 ============
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFile = res.tempFiles[0]
        const srcPath = tempFile.tempFilePath

        // 内容安全检测：通过后再进入处理流程，违规图片直接拦截
        wx.showLoading({ title: '安全检测中...', mask: true })
        checkImageSafe(srcPath)
          .then(() => {
            wx.hideLoading()
            // 先获取图片信息，判断格式
            wx.getImageInfo({
              src: srcPath,
              success: (info) => {
                // JPG 判断用「扩展名 + type 双源」：
                // 部分安卓基础库 getImageInfo 返回 type 为 undefined，
                // 只看 type 会把普通 JPG 误判成非 JPG，白白走进 Canvas 重编码（有 OOM 风险）
                const ext = (srcPath.split('?')[0].split('.').pop() || '').toLowerCase()
                const isJpg = ['jpg', 'jpeg'].indexOf(ext) >= 0
                  || info.type === 'jpg' || info.type === 'jpeg'

                if (!isJpg) {
                  // 非JPG格式（PNG/HEIC等）统一转JPG，不然wx.compressImage会报错
                  wx.showLoading({ title: '格式转换中...' })
                  this.pngToJpg(srcPath, info.width, info.height, (jpgPath) => {
                    wx.hideLoading()
                    // 转码失败不再静默回退原图（原图必然压缩失败、用户无从知晓原因）
                    if (!jpgPath) {
                      wx.showToast({ title: '图片格式转换失败，请换一张试试', icon: 'none' })
                      return
                    }
                    // 压缩比基准用转码后的 JPG 体积，避免 HEIC/PNG 场景"节省 xx%"虚高
                    const convertedBytes = this.getFileSize(jpgPath) || tempFile.size
                    this.setData({
                      originalPath: jpgPath,
                      originalSizeBytes: convertedBytes,
                      originalSize: this.formatSize(convertedBytes),
                      originalWidth: info.width,
                      originalHeight: info.height,
                      compressedPath: ''
                    })
                  })
                } else {
                  // 已经是JPG，直接用
                  this.setData({
                    originalPath: srcPath,
                    originalSizeBytes: tempFile.size,
                    originalSize: this.formatSize(tempFile.size),
                    originalWidth: info.width,
                    originalHeight: info.height,
                    compressedPath: ''
                  })
                }
              },
              fail: () => {
                wx.showToast({ title: '读取图片信息失败，请重试', icon: 'none' })
              }
            })
          })
          .catch((err) => {
            wx.hideLoading()
            if (err && err.risky) showRiskyTip()
            else showUnavailableTip()
          })
      }
    })
  },

  // 读取本地文件体积（失败返回 0）
  getFileSize(path) {
    try {
      const stats = wx.getFileSystemManager().statSync(path)
      return stats.size || 0
    } catch (e) {
      return 0
    }
  },

  // PNG/HEIC → JPG（离屏Canvas，带方向矫正与尺寸保护）
  // 成功 callback(jpgPath)；失败 callback(null)，由调用方明确提示
  pngToJpg(srcPath, width, height, callback) {
    // 大图先等比缩到安全边长，防止原图尺寸直接建 Canvas 导致低端机 OOM
    const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(width, height))
    const drawW = Math.max(1, Math.round(width * scale))
    const drawH = Math.max(1, Math.round(height * scale))

    // 读 EXIF 方向：竖拍照片的像素是"横着存"的，Canvas 重绘不认 Orientation，
    // 必须先按方向预旋转，否则转出来的照片会横躺
    readExifP(srcPath).then((exif) => {
      const orientation = exif.orientation || 1
      const swap = orientation >= 5   // 5-8 需要 90° 类旋转，画布宽高互换
      const canvasW = swap ? drawH : drawW
      const canvasH = swap ? drawW : drawH

      const canvas = wx.createOffscreenCanvas({ type: '2d', width: canvasW, height: canvasH })
      const ctx = canvas.getContext('2d')
      const image = canvas.createImage()

      image.onload = () => {
        // 先铺白底（透明部分变白），必须在设置变换矩阵前用单位矩阵画满画布
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvasW, canvasH)

        // 按 EXIF Orientation 设置变换（1 为正常不需要）
        switch (orientation) {
          case 2: ctx.transform(-1, 0, 0, 1, drawW, 0); break
          case 3: ctx.transform(-1, 0, 0, -1, drawW, drawH); break
          case 4: ctx.transform(1, 0, 0, -1, 0, drawH); break
          case 5: ctx.transform(0, 1, 1, 0, 0, 0); break
          case 6: ctx.transform(0, 1, -1, 0, drawH, 0); break   // 手机竖拍最常见
          case 7: ctx.transform(0, -1, -1, 0, drawH, drawW); break
          case 8: ctx.transform(0, -1, 1, 0, 0, drawW); break
        }
        ctx.drawImage(image, 0, 0, drawW, drawH)

        // 离屏Canvas用全局API导出
        wx.canvasToTempFilePath({
          canvas,
          fileType: 'jpg',
          quality: 0.9,
          success: (res) => {
            callback(res.tempFilePath)
          },
          fail: () => {
            // 转失败回调 null，由调用方提示，不再静默回退原图
            callback(null)
          }
        })
      }

      image.onerror = () => callback(null)
      image.src = srcPath
    })
  },

  // ============ 压缩设置 ============
  onQualityChange(e) {
    this.setData({ quality: e.detail.value, compressedPath: '' })
  },

  switchMode(e) {
    this.setData({ compressMode: e.currentTarget.dataset.mode, compressedPath: '' })
  },

  selectSize(e) {
    this.setData({
      targetSize: parseInt(e.currentTarget.dataset.size),
      customSize: '',  // 选预设时清空自定义
      compressedPath: ''
    })
  },

  onCustomSizeInput(e) {
    this.setData({ customSize: e.detail.value, compressedPath: '' })
  },

  // 清除旧结果，回到设置状态
  resetResult() {
    this.setData({ compressedPath: '' })
    // 滚动到页面顶部，让用户看到设置区域
    wx.pageScrollTo({ scrollTop: 0, duration: 300 })
  },

  // ============ 压缩入口 ============
  compressImage() {
    // 检查今日剩余次数（受总开关控制）
    if (this.data.enableLimit && this.data.dailyLeft <= 0) {
      wx.showModal({
        title: '今日免费次数已用完',
        content: '观看广告可解锁今日无限次压缩',
        confirmText: '看广告',
        cancelText: '明天再来',
        success: (res) => {
          if (res.confirm) {
            this.watchAdForMore()
          }
        }
      })
      return
    }

    this.setData({ compressing: true })

    if (this.data.compressMode === 'targetSize') {
      // 按目标大小：自动迭代压缩
      this.compressToTargetSize()
    } else {
      // 按质量：直接压一次
      this.doCompress(this.data.quality)
    }
  },

  // 单次压缩（按指定质量）
  doCompress(quality) {
    wx.compressImage({
      src: this.data.originalPath,
      quality: quality,
      success: (res) => {
        this.finishCompress(res.tempFilePath, (compressedBytes, savingPercent) => {
          return `压缩完成，省了${savingPercent}%`
        })
      },
      fail: () => {
        wx.showToast({ title: '压缩失败，请重试', icon: 'none' })
      },
      complete: () => {
        this.setData({ compressing: false })
      }
    })
  },

  // 压缩结果落地：查体积、查尺寸、更新结果卡片
  // 所有异步环节都有 fail 兜底，任何一步失败走统一错误出口，不会让按钮卡在"压缩中"
  // tipFn(compressedBytes, savingPercent) 由两种压缩模式各自定制提示文案
  finishCompress(compressedPath, tipFn) {
    const compressedBytes = this.getFileSize(compressedPath)
    if (!compressedBytes) {
      wx.showToast({ title: '压缩失败，请重试', icon: 'none' })
      return
    }

    wx.getImageInfo({
      src: compressedPath,
      success: (imgInfo) => {
        const originalBytes = this.data.originalSizeBytes
        const savingPercent = Math.round((1 - compressedBytes / originalBytes) * 100)

        this.setData({
          compressedPath,
          compressedSizeBytes: compressedBytes,
          compressedSize: this.formatSize(compressedBytes),
          compressedWidth: imgInfo.width,
          compressedHeight: imgInfo.height,
          savingPercent
        })

        this.consumeDailyLimit()

        wx.showToast({ title: tipFn(compressedBytes, savingPercent), icon: 'success' })
      },
      fail: () => {
        // 结果文件读不出来（如临时文件被系统清理）：明确报错，而不是静默卡住
        wx.showToast({ title: '压缩失败，请重试', icon: 'none' })
      }
    })
  },

  // 按目标大小自动迭代压缩
  compressToTargetSize() {
    // 优先用用户输入的自定义大小，否则用预设的
    const userInput = parseInt(this.data.customSize)
    const targetKB = (userInput && userInput > 0) ? userInput : this.data.targetSize
    const targetBytes = targetKB * 1024
    let currentQuality = 70

    const tryCompress = () => {
      wx.compressImage({
        src: this.data.originalPath,
        quality: currentQuality,
        success: (res) => {
          const compressedPath = res.tempFilePath
          const compressedBytes = this.getFileSize(compressedPath)

          // 体积读取失败（结果文件异常）：统一错误出口并复位状态，不再卡死按钮
          if (!compressedBytes) {
            this.setData({ compressing: false })
            wx.showToast({ title: '压缩失败，请重试', icon: 'none' })
            return
          }

          if (compressedBytes <= targetBytes || currentQuality <= 10) {
            // 达标了，或者质量已压到下限 10（与滑条 min 一致）
            this.setData({ compressing: false })
            this.finishCompress(compressedPath, (bytes) => {
              return bytes <= targetBytes
                ? `已压至${this.formatSize(bytes)}`
                : `已到压缩极限，当前${this.formatSize(bytes)}`
            })
          } else {
            // 还太大，降低5个质量再试（步长更细，更容易卡到目标）
            currentQuality -= 5
            tryCompress()
          }
        },
        fail: () => {
          this.setData({ compressing: false })
          wx.showToast({ title: '压缩失败，请重试', icon: 'none' })
        }
      })
    }

    tryCompress()
  },

  // ============ 保存到相册 ============
  saveImage() {
    if (!this.data.compressedPath) return

    this.setData({ saving: true })

    wx.saveImageToPhotosAlbum({
      filePath: this.data.compressedPath,
      success: () => {
        wx.showToast({ title: '已保存到相册', icon: 'success' })
      },
      fail: (err) => {
        if (err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存到相册',
            confirmText: '去设置',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting()
              }
            }
          })
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' })
        }
      },
      complete: () => {
        this.setData({ saving: false })
      }
    })
  },

  handleSaveFail(err) {
    if (err.errMsg.includes('auth deny')) {
      wx.showModal({
        title: '需要相册权限',
        content: '请在设置中允许保存到相册',
        confirmText: '去设置',
        success: (res) => {
          if (res.confirm) {
            wx.openSetting()
          }
        }
      })
    } else {
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  // ============ 激励视频广告：看广告解锁无限次 ============
  watchAdForMore() {
    if (!this.rewardedVideoAd) {
      wx.showToast({ title: '广告加载中，请稍后', icon: 'none' })
      return
    }

    this.rewardedVideoAd.show().catch(() => {
      // 广告没拉到，重新加载
      this.rewardedVideoAd.load()
        .then(() => this.rewardedVideoAd.show())
        .catch(() => {
          wx.showToast({ title: '广告暂未就绪', icon: 'none' })
        })
    })
  },

  initRewardedAd() {
    // 正式上线时把 adUnitIds 换成你自己的激励视频广告位ID
    // 在开发者工具里测试时，用微信提供的测试广告位ID
    const adUnitId = this.data.adUnitIds.rewardedVideoAd

    // 如果还是占位符，不初始化（避免报错）
    if (!adUnitId || adUnitId.includes('xxxx')) {
      return
    }

    this.rewardedVideoAd = wx.createRewardedVideoAd({ adUnitId })

    this.rewardedVideoAd.onError((err) => {
      console.error('激励视频广告错误', err)
    })

    this.rewardedVideoAd.onClose((res) => {
      // 用户看完了广告，发放奖励：今日无限次
      if (res && res.isEnded) {
        wx.showToast({ title: '已解锁今日无限次', icon: 'success' })
        // 把今日剩余次数设为很大
        this.setData({ dailyLeft: 999 })
      } else {
        wx.showToast({ title: '需看完广告才能解锁', icon: 'none' })
      }
    })
  },

  // ============ Banner广告 ============
  initBannerAd() {
    const adUnitId = this.data.adUnitIds.bannerAd

    if (!adUnitId || adUnitId.includes('xxxx')) {
      return
    }

    this.setData({ showBanner: true })
  },

  // ============ 工具：格式化文件大小 ============
  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
  }
})
