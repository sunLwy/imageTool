// ============================================================
// 九宫格切图：自动取画面中间正方形，切 3×3 共 9 张，朋友圈按顺序上传即可拼回
// ============================================================
Page({
  data: {
    hasResult: false,
    chunks: [],        // 9 张导出图路径，行优先（从左到右、从上到下）
    processing: false,
    saving: false,
    saved: false
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (res) => {
        this.cutImage(res.tempFiles[0].tempFilePath)
      }
    })
  },

  cutImage(path) {
    this.setData({ processing: true })
    wx.showLoading({ title: '切图中...' })
    wx.getImageInfo({
      src: path,
      success: async (info) => {
        try {
          const chunks = await this.sliceNine(path, info.width, info.height)
          wx.hideLoading()
          this.setData({ hasResult: true, chunks, processing: false, saved: false })
        } catch (e) {
          wx.hideLoading()
          this.setData({ processing: false })
          wx.showToast({ title: '切图失败，请换一张试试', icon: 'none' })
        }
      },
      fail: () => {
        wx.hideLoading()
        this.setData({ processing: false })
        wx.showToast({ title: '图片读取失败', icon: 'none' })
      }
    })
  },

  // 取中间正方形（边长取 3 的倍数保证每格整数像素），切 3×3
  sliceNine(src, w, h) {
    return new Promise(async (resolve, reject) => {
      const side = Math.floor(Math.min(w, h) / 3) * 3
      const sx = Math.round((w - side) / 2)
      const sy = Math.round((h - side) / 2)
      const cell = side / 3

      const chunks = []
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const out = await this.sliceOne(src, sx + col * cell, sy + row * cell, cell, cell)
          chunks.push(out)
        }
      }
      resolve(chunks)
    })
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

  async saveAll() {
    if (this.data.saving) return
    this.setData({ saving: true })
    let saved = 0
    for (let i = 0; i < this.data.chunks.length; i++) {
      try {
        await new Promise((resolve, reject) => {
          wx.saveImageToPhotosAlbum({
            filePath: this.data.chunks[i],
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
    this.setData({ saving: false, saved: true })
    wx.showToast({ title: `已保存 ${saved} 张`, icon: 'success' })
  },

  reset() {
    this.setData({ hasResult: false, chunks: [], saved: false })
  }
})
