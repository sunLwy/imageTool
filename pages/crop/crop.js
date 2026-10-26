Page({
  data: {
    hasImage: false,
    src: '',
    originW: 0,   // 原图宽（px）
    originH: 0,   // 原图高（px）

    // 裁剪舞台（正方形）与裁剪框（屏幕 px）
    areaW: 0,
    areaH: 0,
    frameW: 0,
    frameH: 0,
    frameLeft: 0,
    frameTop: 0,

    // 图片 cover 裁剪框后的尺寸与初始左上角
    imgW: 0,
    imgH: 0,
    imgLeft: 0,
    imgTop: 0,

    // 自定义手势变换：相对初始中心的位移 + 缩放
    tx: 0,
    ty: 0,
    scale: 1,
    animating: false,

    // 比例（iPhone 照片风格，横屏在前）
    ratio: 'free',
    ratioOptions: [
      { label: '自由', value: 'free' },
      { label: '方形', value: '1:1' },
      { label: '16:9', value: '16:9' },
      { label: '4:3', value: '4:3' },
      { label: '3:4', value: '3:4' },
      { label: '9:16', value: '9:16' }
    ],

    cropping: false,
    resultPath: '',
    resultSize: '',
    saving: false
  },

  // 图片 cover 适配裁剪框时的缩放系数（导出坐标映射用）
  scale0: 0,
  stageCx: 0,   // 舞台中心屏幕坐标
  stageCy: 0,
  gesture: null,

  onLoad() {
    const win = wx.getWindowInfo()
    // container 左右 padding 各 32rpx；舞台取正方形
    const paddingPx = 32 * win.windowWidth / 750
    const stage = win.windowWidth - paddingPx * 2
    this.stageSize = stage
    this.setData({ areaW: stage, areaH: stage })
  },

  // ============ 选图 ============
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const src = res.tempFiles[0].tempFilePath
        wx.getImageInfo({
          src,
          success: (info) => {
            // 非 JPG（PNG/HEIC 等）先统一转 JPG，否则 canvas 解码会失败
            const isJpg = info.type === 'jpg' || info.type === 'jpeg'
            if (!isJpg) {
              wx.showLoading({ title: '格式转换中...' })
              this.toJpg(src, info.width, info.height, (jpgPath) => {
                wx.hideLoading()
                this.enterEdit(jpgPath, info.width, info.height)
              })
            } else {
              this.enterEdit(src, info.width, info.height)
            }
          }
        })
      }
    })
  },

  // 进入编辑态
  enterEdit(src, w, h) {
    // 保存最初的图片，用于"重置"还原旋转/比例/缩放
    this.baseSrc = src
    this.baseW = w
    this.baseH = h
    this.setData({
      src,
      originW: w,
      originH: h,
      hasImage: true,
      resultPath: '',
      ratio: 'free'
    })
    this.layoutCrop()
    // 渲染后取舞台中心屏幕坐标，用于双指缩放锚点计算
    wx.nextTick(() => {
      wx.createSelectorQuery().in(this)
        .select('.crop-stage')
        .boundingClientRect((rect) => {
          if (rect) {
            this.stageCx = rect.left + rect.width / 2
            this.stageCy = rect.top + rect.height / 2
          }
        })
        .exec()
    })
  },

  // 非 JPG 转 JPG（离屏 Canvas，透明区域铺白底）
  toJpg(src, width, height, callback) {
    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
    const ctx = canvas.getContext('2d')
    const image = canvas.createImage()
    image.onload = () => {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(image, 0, 0, width, height)
      wx.canvasToTempFilePath({
        canvas,
        fileType: 'jpg',
        quality: 0.9,
        success: (res) => callback(res.tempFilePath),
        fail: () => callback(src)  // 转失败就硬上原图
      })
    }
    image.onerror = () => callback(src)
    image.src = src
  },

  // 根据当前比例重新计算裁剪框和图片布局
  layoutCrop() {
    const stage = this.stageSize
    const { originW, originH, ratio } = this.data

    // 裁剪框宽高比
    let rw, rh
    switch (ratio) {
      case '1:1':  rw = 1;  rh = 1;  break
      case '3:4':  rw = 3;  rh = 4;  break
      case '4:3':  rw = 4;  rh = 3;  break
      case '9:16': rw = 9;  rh = 16; break
      case '16:9': rw = 16; rh = 9;  break
      default:     rw = originW; rh = originH
    }

    // 裁剪框在正方形舞台内最大居中
    let frameW = stage
    let frameH = stage * rh / rw
    if (frameH > stage) {
      frameH = stage
      frameW = stage * rw / rh
    }
    const frameLeft = (stage - frameW) / 2
    const frameTop = (stage - frameH) / 2

    // 图片 cover 铺满裁剪框
    const scale0 = Math.max(frameW / originW, frameH / originH)
    const imgW = originW * scale0
    const imgH = originH * scale0
    // 图片初始左上角，使其在裁剪框内居中（后续位移/缩放用 transform 叠加）
    const imgLeft = frameLeft + (frameW - imgW) / 2
    const imgTop = frameTop + (frameH - imgH) / 2

    this.scale0 = scale0
    this.frameLeft = frameLeft
    this.frameTop = frameTop
    this.frameW = frameW
    this.frameH = frameH
    this.gesture = null
    this.setData({
      frameW, frameH, frameLeft, frameTop,
      imgW, imgH, imgLeft, imgTop,
      tx: 0, ty: 0, scale: 1, animating: false
    })
  },

  // ============ 自定义手势（单指拖动 + 双指缩放） ============
  onTouchStart(e) {
    this.setData({ animating: false })
    const t = e.touches
    const { tx, ty, scale } = this.data

    if (t.length === 1) {
      this.gesture = {
        mode: 'pan',
        x0: t[0].clientX,
        y0: t[0].clientY,
        tx0: tx,
        ty0: ty
      }
    } else if (t.length === 2) {
      this.gesture = this.buildPinch(t, tx, ty, scale)
    }
  },

  onTouchMove(e) {
    const t = e.touches
    let g = this.gesture

    if (t.length === 1 && g && g.mode === 'pan') {
      this.setData({
        tx: g.tx0 + (t[0].clientX - g.x0),
        ty: g.ty0 + (t[0].clientY - g.y0)
      })
    } else if (t.length === 2) {
      // 单指拖动过程中第二指落下，切换为缩放
      if (!g || g.mode !== 'pinch') {
        this.gesture = this.buildPinch(t, this.data.tx, this.data.ty, this.data.scale)
        return
      }
      const dist = this.getDist(t)
      const mid = this.getMid(t)
      let ns = g.scale0 * (dist / g.dist0)
      ns = Math.min(5, Math.max(1, ns))
      const k = ns / g.scale0
      // 以当前双指中点为锚点缩放
      const tx = mid.x - (mid.x - g.tx0) * k
      const ty = mid.y - (mid.y - g.ty0) * k
      this.setData({ scale: ns, tx, ty })
    }
  },

  onTouchEnd() {
    // 松手吸附：保证图片始终铺满裁剪框、不露黑边
    const { scale, tx, ty, imgW, imgH } = this.data
    const { frameW, frameH } = this
    const halfW = imgW * scale / 2
    const halfH = imgH * scale / 2
    // 中心位移允许范围（相对裁剪框中心）
    const minTx = frameW / 2 - halfW
    const maxTx = halfW - frameW / 2
    const minTy = frameH / 2 - halfH
    const maxTy = halfH - frameH / 2
    const ntx = Math.max(minTx, Math.min(tx, maxTx))
    const nty = Math.max(minTy, Math.min(ty, maxTy))

    this.setData({ animating: true, tx: ntx, ty: nty })
  },

  buildPinch(t, tx, ty, scale) {
    return {
      mode: 'pinch',
      dist0: this.getDist(t),
      tx0: tx,
      ty0: ty,
      scale0: scale
    }
  },

  getDist(t) {
    const dx = t[0].clientX - t[1].clientX
    const dy = t[0].clientY - t[1].clientY
    return Math.hypot(dx, dy)
  },

  getMid(t) {
    // 中点换算为相对舞台中心的坐标
    return {
      x: (t[0].clientX + t[1].clientX) / 2 - this.stageCx,
      y: (t[0].clientY + t[1].clientY) / 2 - this.stageCy
    }
  },

  selectRatio(e) {
    this.setData({ ratio: e.currentTarget.dataset.value })
    this.layoutCrop()
  },

  // 取消：退出编辑，回到选图
  cancelEdit() {
    this.setData({ hasImage: false, src: '', resultPath: '' })
  },

  // 重置：还原到最初图片（撤销旋转、比例、缩放、拖动）
  resetView() {
    if (!this.baseSrc) return
    this.setData({
      src: this.baseSrc,
      originW: this.baseW,
      originH: this.baseH,
      ratio: 'free',
      resultPath: ''
    })
    this.layoutCrop()
  },

  // ============ 左转90° ============
  rotateLeft() {
    const { src, originW, originH } = this.data
    if (!src) return
    wx.showLoading({ title: '旋转中...' })

    // 旋转后宽高交换，确保是整数
    const w = Math.round(originH)
    const h = Math.round(originW)

    const canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
    const ctx = canvas.getContext('2d')
    const image = canvas.createImage()

    image.onload = () => {
      // 以中心为原点，顺时针旋转 90° 即视觉上的左转
      ctx.clearRect(0, 0, w, h)
      ctx.translate(w / 2, h / 2)
      ctx.rotate(Math.PI / 2)
      ctx.drawImage(image, -originW / 2, -originH / 2, originW, originH)

      wx.canvasToTempFilePath({
        canvas,
        fileType: 'jpg',
        quality: 0.9,
        success: (res) => {
          wx.hideLoading()
          this.setData({
            src: res.tempFilePath,
            originW: originH,
            originH: originW
          })
          this.layoutCrop()
        },
        fail: (err) => {
          wx.hideLoading()
          console.error('旋转导出失败', err)
          wx.showToast({ title: '旋转失败：' + (err.errMsg || ''), icon: 'none' })
        }
      })
    }
    image.onerror = (err) => {
      wx.hideLoading()
      console.error('旋转图片解码失败', err, 'src=', src)
      wx.showToast({ title: '图片格式暂不支持旋转', icon: 'none' })
    }
    image.src = src
  },

  // ============ 导出裁剪 ============
  doCrop() {
    this.setData({ cropping: true })

    const { imgW, imgH, tx, ty, scale } = this.data
    const { frameW, frameH, scale0 } = this

    // 图片中心相对裁剪框中心偏移 (tx,ty)，视觉左上角（裁剪框坐标系）：
    //   frameW/2 - imgW*scale/2 + tx
    // 裁剪框左上角相对图片视觉左上角，再换算回原图坐标
    const totalScale = scale0 * scale
    const srcX = (imgW * scale / 2 - frameW / 2 - tx) / totalScale
    const srcY = (imgH * scale / 2 - frameH / 2 - ty) / totalScale
    const srcW = frameW / totalScale
    const srcH = frameH / totalScale

    const canvas = wx.createOffscreenCanvas({ type: '2d', width: Math.round(srcW), height: Math.round(srcH) })
    const ctx = canvas.getContext('2d')
    const image = canvas.createImage()

    image.onload = () => {
      ctx.drawImage(image, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH)
      wx.canvasToTempFilePath({
        canvas,
        fileType: 'jpg',
        quality: 0.9,
        success: (res) => {
          wx.getFileInfo({
            filePath: res.tempFilePath,
            success: (fileInfo) => {
              this.setData({
                resultPath: res.tempFilePath,
                resultSize: this.formatSize(fileInfo.size),
                cropping: false
              })
              wx.showToast({ title: '裁剪完成', icon: 'success' })
            }
          })
        },
        fail: (err) => {
          this.setData({ cropping: false })
          console.error('裁剪导出失败', err)
          wx.showToast({ title: '裁剪失败', icon: 'none' })
        }
      })
    }
    image.src = this.data.src
  },

  // ============ 保存 ============
  saveImage() {
    if (!this.data.resultPath) return
    this.setData({ saving: true })
    wx.saveImageToPhotosAlbum({
      filePath: this.data.resultPath,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: (err) => {
        if (err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存到相册',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting() }
          })
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' })
        }
      },
      complete: () => this.setData({ saving: false })
    })
  },

  resetEdit() {
    this.setData({ resultPath: '' })
  },

  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
  }
})
