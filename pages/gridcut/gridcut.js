// ============================================================
// 九宫格切图：选图后直接在带 3×3 网格线的预览里拖动对齐，所见即所得，一键切 9 张保存
// ============================================================
const { checkImageSafe, showRiskyTip, showUnavailableTip } = require('../../utils/security')

Page({
  data: {
    phase: 'pick',      // pick 选图 / editing 拖动对齐
    cropPath: '',
    cropDir: 'square',  // v 竖图(上下拖) / h 横图(左右拖) / square 方图
    areaSize: 300,
    viewW: 300,
    viewH: 300,
    initX: 0,
    initY: 0,
    saving: false
  },

  dragT: 0.5,
  srcW: 0,
  srcH: 0,

  onLoad() {
    const info = wx.getSystemInfoSync()
    const padPx = 32 * (info.windowWidth / 750)
    this.setData({ areaSize: Math.round(info.windowWidth - padPx * 2) })
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (res) => {
        const path = res.tempFiles[0].tempFilePath
        // 内容安全检测：通过后再进入切图预览
        wx.showLoading({ title: '检测中...', mask: true })
        checkImageSafe(path)
          .then(() => {
            wx.hideLoading()
            this.setupCrop(path)
          })
          .catch((err) => {
            wx.hideLoading()
            if (err && err.risky) showRiskyTip()
            else showUnavailableTip()
          })
      }
    })
  },

  setupCrop(path) {
    wx.showLoading({ title: '读取中...' })
    wx.getImageInfo({
      src: path,
      success: (info) => {
        wx.hideLoading()
        const w = info.width
        const h = info.height
        this.srcW = w
        this.srcH = h
        this.dragT = 0.5
        const area = this.data.areaSize
        let cropDir, viewW, viewH, initX = 0, initY = 0
        if (Math.abs(w - h) < Math.min(w, h) * 0.03) {
          cropDir = 'square'
          viewW = viewH = area
        } else if (h > w) {
          cropDir = 'v'
          viewW = area
          viewH = Math.round(area * h / w)
          initY = -Math.round((viewH - area) / 2)
        } else {
          cropDir = 'h'
          viewW = Math.round(area * w / h)
          viewH = area
          initX = -Math.round((viewW - area) / 2)
        }
        this.setData({
          phase: 'editing',
          cropPath: path,
          cropDir,
          viewW,
          viewH,
          initX,
          initY
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '图片读取失败', icon: 'none' })
      }
    })
  },

  onDragChange(e) {
    const { areaSize, viewW, viewH, cropDir } = this.data
    if (cropDir === 'v') {
      const range = viewH - areaSize
      if (range <= 0) return
      this.dragT = Math.min(1, Math.max(0, -e.detail.y / range))
    } else if (cropDir === 'h') {
      const range = viewW - areaSize
      if (range <= 0) return
      this.dragT = Math.min(1, Math.max(0, -e.detail.x / range))
    }
  },

  // 切 9 张并直接保存
  async cutAndSave() {
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '切图中...' })
    const w = this.srcW
    const h = this.srcH
    let side = Math.floor(Math.min(w, h) / 3) * 3
    let sx = 0, sy = 0
    if (h > w) {
      sx = 0
      sy = Math.round(this.dragT * (h - side))
    } else if (w > h) {
      sy = 0
      sx = Math.round(this.dragT * (w - side))
    } else {
      sx = Math.round((w - side) / 2)
      sy = Math.round((h - side) / 2)
    }
    const cell = side / 3

    try {
      const chunks = await this.sliceAll(this.data.cropPath, sx, sy, cell)
      wx.hideLoading()
      await this.saveChunks(chunks)
    } catch (e) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: '切图失败，请换一张', icon: 'none' })
    }
  },

  async sliceAll(src, sx0, sy0, cell) {
    const chunks = []
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        chunks.push(await this.sliceOne(src, sx0 + col * cell, sy0 + row * cell, cell, cell))
      }
    }
    return chunks
  },

  sliceOne(src, sx, sy, sw, sh) {
    return new Promise((resolve, reject) => {
      const canvas = wx.createOffscreenCanvas({ type: '2d', width: sw, height: sh })
      const ctx = canvas.getContext('2d')
      const image = canvas.createImage()
      image.onload = () => {
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
        wx.canvasToTempFilePath({
          canvas,
          fileType: 'jpg',
          quality: 0.95,
          success: (res) => resolve(res.tempFilePath),
          fail: reject
        })
      }
      image.onerror = reject
      image.src = src
    })
  },

  async saveChunks(chunks) {
    let saved = 0
    for (let i = 0; i < chunks.length; i++) {
      try {
        await new Promise((resolve, reject) => {
          wx.saveImageToPhotosAlbum({
            filePath: chunks[i],
            success: resolve,
            fail: reject
          })
        })
        saved++
      } catch (e) {
        if (e && e.errMsg && e.errMsg.indexOf('auth deny') >= 0) {
          this.setData({ saving: false })
          wx.showModal({
            title: '提示',
            content: '需要相册权限才能保存图片，请在设置中开启',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting() }
          })
          return
        }
      }
    }
    this.setData({ saving: false })
    wx.showToast({ title: `已保存 ${saved} 张，去朋友圈按顺序选`, icon: 'none' })
  },

  reset() {
    this.setData({ phase: 'pick', cropPath: '' })
  }
})
