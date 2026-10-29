const app = getApp()
const { checkImageSafe, showRiskyTip, showUnavailableTip } = require('../../utils/security')

Page({
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
    adUnitIds: app.globalData.adUnitIds,

    // 隐私弹窗
    showPrivacyModal: false
  },

  onLoad() {
    this.loadDailyLimit()
    this.initBannerAd()
    this.initRewardedAd()
    this.checkPrivacyAgreement()
  },

  // ============ 隐私协议 ============
  checkPrivacyAgreement() {
    const agreed = wx.getStorageSync('privacyAgreed')
    if (!agreed) {
      this.setData({ showPrivacyModal: true })
    }
  },

  agreePrivacy() {
    wx.setStorageSync('privacyAgreed', true)
    this.setData({ showPrivacyModal: false })
    wx.showToast({ title: '欢迎使用', icon: 'success' })
  },

  rejectPrivacy() {
    wx.showModal({
      title: '需要同意隐私协议',
      content: '不同意隐私协议将无法使用本小程序',
      showCancel: false,
      success: () => {
        this.setData({ showPrivacyModal: true })
      }
    })
  },

  onPrivacyMaskTap() {
    // 点击遮罩不关闭，必须点按钮
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
                // 非JPG格式（PNG/HEIC等）统一转JPG，不然wx.compressImage会报错
                const isJpg = info.type === 'jpg' || info.type === 'jpeg'

                if (!isJpg) {
                  wx.showLoading({ title: '格式转换中...' })
                  this.pngToJpg(srcPath, info.width, info.height, (jpgPath) => {
                    wx.hideLoading()
                    this.setData({
                      originalPath: jpgPath,
                      originalSizeBytes: tempFile.size,
                      originalSize: this.formatSize(tempFile.size),
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

  // PNG转JPG（离屏Canvas）
  pngToJpg(srcPath, width, height, callback) {
    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
    const ctx = canvas.getContext('2d')
    const image = canvas.createImage()

    image.onload = () => {
      // 先铺白底（透明部分变白）
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      // 画图片
      ctx.drawImage(image, 0, 0, width, height)

      // 离屏Canvas用全局API导出
      wx.canvasToTempFilePath({
        canvas,
        fileType: 'jpg',
        quality: 0.9,
        success: (res) => {
          callback(res.tempFilePath)
        },
        fail: () => {
          // 转失败就用原图
          callback(srcPath)
        }
      })
    }

    image.src = srcPath
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
        const compressedPath = res.tempFilePath

        wx.getFileInfo({
          filePath: compressedPath,
          success: (fileInfo) => {
            wx.getImageInfo({
              src: compressedPath,
              success: (imgInfo) => {
                const originalBytes = this.data.originalSizeBytes
                const compressedBytes = fileInfo.size
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

                wx.showToast({
                  title: `压缩完成，省了${savingPercent}%`,
                  icon: 'success'
                })
              }
            })
          }
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

          wx.getFileInfo({
            filePath: compressedPath,
            success: (fileInfo) => {
              const compressedBytes = fileInfo.size

              if (compressedBytes <= targetBytes || currentQuality <= 10) {
                // 达标了，或者已经压到极限了（质量不能低于20）
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
                      savingPercent,
                      compressing: false
                    })

                    this.consumeDailyLimit()

                    const tip = compressedBytes <= targetBytes
                      ? `已压至${this.formatSize(compressedBytes)}`
                      : `已到压缩极限，当前${this.formatSize(compressedBytes)}`

                    wx.showToast({ title: tip, icon: 'success' })
                  }
                })
              } else {
                // 还太大，降低5个质量再试（步长更细，更容易卡到目标）
                currentQuality -= 5
                tryCompress()
              }
            }
          })
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
      console.log('激励视频广告位未配置，跳过初始化')
      return
    }

    this.rewardedVideoAd = wx.createRewardedVideoAd({ adUnitId })

    this.rewardedVideoAd.onLoad(() => {
      console.log('激励视频广告加载完成')
    })

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
      console.log('Banner广告位未配置，跳过')
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
