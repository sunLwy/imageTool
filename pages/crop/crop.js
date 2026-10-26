Page({
  data: {
    hasImage: false,
    src: '',
    originW: 0,   // 原图宽（px）
    originH: 0,   // 原图高（px）

    // 裁剪框尺寸（屏幕 px）——舞台为正方形，裁剪框在其中居中
    areaW: 0,
    areaH: 0,
    bigSize: 0,    // 扩大的可拖动区域（3倍舞台）
    bigOffset: 0,  // 大区域相对舞台的偏移（负值）
    frameW: 0,
    frameH: 0,
    frameLeft: 0,
    frameTop: 0,

    // movable-view 内图片尺寸与位置
    imgW: 0,
    imgH: 0,
    movableX: 0,
    movableY: 0,

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

  onLoad() {
    const win = wx.getWindowInfo()
    // container 左右 padding 各 32rpx；舞台取正方形
    const paddingPx = 32 * win.windowWidth / 750
    const stage = win.windowWidth - paddingPx * 2
    this.stageSize = stage
    // 可拖动区域放大 3 倍并居中，四周各扩出一个舞台，保证图片边缘能拖到裁剪框
    const bigSize = stage * 3
    const bigOffset = (stage - bigSize) / 2
    this.bigSize = bigSize
    this.bigOffset = bigOffset
    this.setData({ areaW: stage, areaH: stage, bigSize, bigOffset })
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
    this.setData({
      src,
      originW: w,
      originH: h,
      hasImage: true,
      resultPath: ''
    })
    this.layoutCrop()
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
    // 裁剪框在扩大区域中的坐标（扩大区域左上角相对舞台为 bigOffset）
    const fx = frameLeft - this.bigOffset
    const fy = frameTop - this.bigOffset
    // 图片初始在裁剪框内居中（大区域坐标）
    const movableX = fx + (frameW - imgW) / 2
    const movableY = fy + (frameH - imgH) / 2

    this.scale0 = scale0
    this.frameLeft = frameLeft
    this.frameTop = frameTop
    this.frameW = frameW
    this.frameH = frameH
    this.fx = fx
    this.fy = fy
    this.curScale = 1
    this.curX = movableX
    this.curY = movableY
    this.setData({
      frameW, frameH, frameLeft, frameTop,
      imgW, imgH, movableX, movableY
    })
  },

  // 当前双指缩放倍数与位置（手势期间只读取，绝不 setData 回写，否则会闪烁回弹）
  curScale: 1,
  curX: 0,
  curY: 0,

  onMove(e) {
    this.curX = e.detail.x
    this.curY = e.detail.y
  },

  onScale(e) {
    this.curScale = e.detail.scale
    this.curX = e.detail.x
    this.curY = e.detail.y
  },

  // 松手后自动吸附，保证图片始终铺满裁剪框、不露黑边
  onTouchEnd() {
    // 延迟一帧，等双指缩放的最终 scale 落定
    setTimeout(() => this.snapToFrame(), 0)
  },

  snapToFrame() {
    const { imgW, imgH } = this.data
    const { fx, fy, frameW, frameH } = this
    const s = this.curScale || 1
    const halfW = imgW * (s - 1) / 2
    const halfH = imgH * (s - 1) / 2
    const visW = imgW * s
    const visH = imgH * s

    // 视觉左上角（大区域坐标，含中心锚点缩放修正）
    let visLeft = this.curX - halfW
    let visTop = this.curY - halfH

    // 水平约束：图片不得窄于裁剪框
    if (visW >= frameW) {
      visLeft = Math.min(visLeft, fx)
      visLeft = Math.max(visLeft, fx + frameW - visW)
    } else {
      visLeft = fx + (frameW - visW) / 2
    }
    // 垂直约束
    if (visH >= frameH) {
      visTop = Math.min(visTop, fy)
      visTop = Math.max(visTop, fy + frameH - visH)
    } else {
      visTop = fy + (frameH - visH) / 2
    }

    // 转回 movable-view 的 x/y 并吸附回去
    const targetX = visLeft + halfW
    const targetY = visTop + halfH
    this.curX = targetX
    this.curY = targetY
    this.setData({ movableX: targetX, movableY: targetY })
  },

  selectRatio(e) {
    this.setData({ ratio: e.currentTarget.dataset.value })
    this.layoutCrop()
  },

  // 取消：退出编辑，回到选图
  cancelEdit() {
    this.setData({ hasImage: false, src: '', resultPath: '' })
  },

  // 重置：图片回到当前状态的初始位置与缩放（不还原旋转）
  resetView() {
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

    const { imgW, imgH } = this.data
    const { fx, fy, frameW, frameH, scale0 } = this
    const s = this.curScale || 1   // 双指缩放倍数

    // movable-view 以中心为锚点缩放，视觉左上角要做修正（大区域坐标）
    const visLeftX = this.curX - imgW * (s - 1) / 2
    const visLeftY = this.curY - imgH * (s - 1) / 2

    // 裁剪框左上角相对图片视觉左上角，再换算回原图坐标
    const totalScale = scale0 * s
    const srcX = (fx - visLeftX) / totalScale
    const srcY = (fy - visLeftY) / totalScale
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
