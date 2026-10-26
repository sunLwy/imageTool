// ============================================================
// 照片时间水印：自动读取 EXIF 拍摄时间并绘制到照片（冲印日期戳）
// ============================================================

// 从 JPEG 二进制解析 EXIF 拍摄时间(DateTimeOriginal)与方向(Orientation)
// 仅解析需要的两个 tag，返回 { dateTime: 'YYYY:MM:DD HH:MM:SS', orientation: 1 }
function readExif(buffer) {
  const result = { dateTime: null, orientation: 1 }
  try {
    const dv = new DataView(buffer)
    if (buffer.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return result // 非 JPEG

    const littleAt = (little) => little
      ? (o) => dv.getUint16(o, true)
      : (o) => dv.getUint16(o, false)
    const littleAt32 = (little) => little
      ? (o) => dv.getUint32(o, true)
      : (o) => dv.getUint32(o, false)

    let offset = 2
    while (offset + 4 < buffer.byteLength) {
      const marker = dv.getUint16(offset)
      if (marker === 0xFFE1) { // APP1
        const segLen = dv.getUint16(offset + 2)
        // 标识 "Exif\0\0"
        if (dv.getUint32(offset + 4) === 0x45786966 && dv.getUint16(offset + 8) === 0x0000) {
          parseTiff(dv, offset + 10, result)
          return result
        }
        offset += 2 + segLen
      } else if (marker === 0xFFDA || marker === 0xFFD9) {
        // SOS 扫描数据起始 / EOI 结束，后面再无元数据段
        break
      } else if ((marker & 0xFF00) === 0xFF00) {
        offset += 2 + dv.getUint16(offset + 2)
      } else {
        break
      }
    }
  } catch (e) {
    // 解析失败静默兜底
  }
  return result
}

function parseTiff(dv, tiffStart, result) {
  const bo = dv.getUint16(tiffStart)
  const little = bo === 0x4949 // 'II' 小端，否则 'MM' 大端
  const g16 = little ? (o) => dv.getUint16(o, true) : (o) => dv.getUint16(o, false)
  const g32 = little ? (o) => dv.getUint32(o, true) : (o) => dv.getUint32(o, false)

  const readAscii = (entry) => {
    const count = g32(entry + 4)
    let p = count <= 4 ? entry + 8 : tiffStart + g32(entry + 8)
    let s = ''
    for (let i = 0; i < count; i++) {
      const c = dv.getUint8(p + i)
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s.trim()
  }

  // IFD0
  const ifd0 = tiffStart + g32(tiffStart + 4)
  const n0 = g16(ifd0)
  let subIfdOffset = null
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12
    const tag = g16(e)
    if (tag === 0x8769) subIfdOffset = g32(e + 8)      // Exif SubIFD 指针
    else if (tag === 0x0112) result.orientation = g16(e + 8) // Orientation
    else if (tag === 0x0132 && !result.dateTime) result.dateTime = readAscii(e) // DateTime 兜底
  }

  // Exif SubIFD → DateTimeOriginal (0x9003)
  if (subIfdOffset != null) {
    const sub = tiffStart + subIfdOffset
    const n1 = g16(sub)
    for (let i = 0; i < n1; i++) {
      const e = sub + 2 + i * 12
      if (g16(e) === 0x9003) {
        const v = readAscii(e)
        if (v) result.dateTime = v
        break
      }
    }
  }
}

Page({
  data: {
    hasImage: false,
    previewPath: '',

    // 选项
    stampStyle: 'classic',   // classic 经典冲印 / minimal 简约
    showTime: false,         // true 日期+时间 / false 仅日期（默认仅日期）
    fontSizeLevel: 'm',      // s 小 / m 中（默认）/ l 大
    position: 'rb',          // lt rt lb rb
    stampDate: '',
    stampTime: '',
    exifDetected: false,

    saving: false,
    rendering: false
  },

  fixedPath: '',   // 转正后的正向 JPG
  fw: 0,
  fh: 0,
  renderToken: 0,

  onLoad() {
    const now = new Date()
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    this.setData({
      stampDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      stampTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`
    })
  },

  // ============ 选图（必须原图，否则 EXIF 丢失） ============
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (res) => {
        const file = res.tempFiles[0]
        this.loadFile(file.tempFilePath)
      }
    })
  },

  loadFile(path) {
    wx.showLoading({ title: '读取中...' })
    const fs = wx.getFileSystemManager()
    fs.readFile({
      filePath: path,
      success: (bufRes) => {
        const exif = readExif(bufRes.data)
        let date = this.data.stampDate
        let time = this.data.stampTime
        let detected = false
        if (exif.dateTime && exif.dateTime.length >= 10) {
          const m = exif.dateTime.match(/^(\d{4}):(\d{2}):(\d{2})(?:\s+(\d{2}):(\d{2}))?/)
          if (m) {
            date = `${m[1]}-${m[2]}-${m[3]}`
            time = m[4] ? `${m[4]}:${m[5]}` : '00:00'
            detected = true
          }
        }
        wx.getImageInfo({
          src: path,
          success: (info) => {
            this.normalize(path, info.width, info.height, exif.orientation || 1, (fixedPath, fw, fh) => {
              wx.hideLoading()
              this.fixedPath = fixedPath
              this.fw = fw
              this.fh = fh
              this.setData({
                hasImage: true,
                stampDate: date,
                stampTime: time,
                exifDetected: detected
              })
              this.render()
              if (!detected) {
                wx.showToast({ title: '未检测到拍摄时间，可手动修改', icon: 'none' })
              }
            })
          },
          fail: () => {
            wx.hideLoading()
            wx.showToast({ title: '图片读取失败', icon: 'none' })
          }
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '图片读取失败', icon: 'none' })
      }
    })
  },

  // 按 EXIF Orientation 把图片转成正向 JPG（输出尺寸即正向宽高）
  normalize(src, w, h, orientation, cb) {
    let cw = w
    let ch = h
    let rot = 0
    if (orientation === 6) { cw = h; ch = w; rot = 90 }
    else if (orientation === 8) { cw = h; ch = w; rot = -90 }
    else if (orientation === 3) { cw = w; ch = h; rot = 180 }

    const canvas = wx.createOffscreenCanvas({ type: '2d', width: cw, height: ch })
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cw, ch)
    const image = canvas.createImage()
    image.onload = () => {
      ctx.save()
      ctx.translate(cw / 2, ch / 2)
      if (rot) ctx.rotate(rot * Math.PI / 180)
      ctx.drawImage(image, -w / 2, -h / 2, w, h)
      ctx.restore()
      wx.canvasToTempFilePath({
        canvas,
        fileType: 'jpg',
        quality: 0.95,
        success: (res) => cb(res.tempFilePath, cw, ch),
        fail: () => cb(src, cw, ch)
      })
    }
    image.onerror = () => {
      // 解码失败（如 HEIC），直接退回原路径
      wx.hideLoading()
      wx.showToast({ title: '该图片格式暂不支持', icon: 'none' })
    }
    image.src = src
  },

  // ============ 选项交互 ============
  setStyle(e) {
    this.setData({ stampStyle: e.currentTarget.dataset.value })
    this.render()
  },
  setFormat(e) {
    this.setData({ showTime: e.currentTarget.dataset.value === 'datetime' })
    this.render()
  },
  setFontSize(e) {
    this.setData({ fontSizeLevel: e.currentTarget.dataset.level })
    this.render()
  },
  setPosition(e) {
    this.setData({ position: e.currentTarget.dataset.value })
    this.render()
  },
  onDateChange(e) {
    this.setData({ stampDate: e.detail.value })
    this.render()
  },
  onTimeChange(e) {
    this.setData({ stampTime: e.detail.value })
    this.render()
  },

  // ============ 渲染时间戳 ============
  buildText() {
    const d = this.data.stampDate.replace(/-/g, '.')
    return this.data.showTime ? `${d} ${this.data.stampTime}` : d
  },

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  },

  render() {
    if (!this.fixedPath) return
    const token = ++this.renderToken
    this.setData({ rendering: true })
    const { fw, fh } = this
    const text = this.buildText()
    const { stampStyle, position } = this.data

    const canvas = wx.createOffscreenCanvas({ type: '2d', width: fw, height: fh })
    const ctx = canvas.getContext('2d')
    const image = canvas.createImage()
    image.onload = () => {
      ctx.drawImage(image, 0, 0, fw, fh)

      const short = Math.min(fw, fh)
      const sizeScale = { s: 0.024, m: 0.032, l: 0.044 }[this.data.fontSizeLevel]
      const fs = Math.round(short * sizeScale)  // 经典款字号
      const margin = Math.round(short * 0.035)

      if (stampStyle === 'classic') {
        ctx.font = `bold ${fs}px "Courier New", monospace`
        ctx.textBaseline = 'alphabetic'
        const tw = ctx.measureText(text).width
        const box = this.placeBox(position, tw, fs, margin, fw, fh)
        ctx.lineJoin = 'round'
        ctx.lineWidth = Math.max(2, fs / 9)
        ctx.strokeStyle = 'rgba(0,0,0,0.85)'
        ctx.strokeText(text, box.x, box.y + fs * 0.82)
        ctx.fillStyle = '#ffb347' // 经典暖橙
        ctx.fillText(text, box.x, box.y + fs * 0.82)
      } else {
        const fontPx = Math.round(fs * 0.78)
        ctx.font = `${fontPx}px -apple-system, "PingFang SC", sans-serif`
        ctx.textBaseline = 'alphabetic'
        const tw = ctx.measureText(text).width
        const padX = Math.round(fs * 0.5)
        const padY = Math.round(fs * 0.34)
        const bw = tw + padX * 2
        const bh = fontPx + padY * 2
        const box = this.placeBox(position, bw, bh, margin, fw, fh)
        ctx.fillStyle = 'rgba(255,255,255,0.72)'
        this.roundRect(ctx, box.x, box.y, bw, bh, Math.round(fs * 0.3))
        ctx.fill()
        ctx.fillStyle = 'rgba(35,35,35,0.95)'
        ctx.fillText(text, box.x + padX, box.y + padY + fontPx * 0.78)
      }

      wx.canvasToTempFilePath({
        canvas,
        fileType: 'jpg',
        quality: 0.95,
        success: (res) => {
          if (token !== this.renderToken) return // 丢弃过期结果
          this.setData({ previewPath: res.tempFilePath, rendering: false })
        },
        fail: () => {
          if (token !== this.renderToken) return
          this.setData({ rendering: false })
          wx.showToast({ title: '生成失败', icon: 'none' })
        }
      })
    }
    image.onerror = () => {
      this.setData({ rendering: false })
      wx.showToast({ title: '图片处理失败', icon: 'none' })
    }
    image.src = this.fixedPath
  },

  // 根据四角位置计算绘制盒左上角（编码：第1位左右 l/r，第2位上下 t/b）
  placeBox(position, bw, bh, margin, fw, fh) {
    const x = position[0] === 'r' ? fw - margin - bw : margin
    const y = position[1] === 'b' ? fh - margin - bh : margin
    return { x, y }
  },

  // ============ 保存 ============
  saveImage() {
    if (!this.data.previewPath) return
    this.setData({ saving: true })
    wx.saveImageToPhotosAlbum({
      filePath: this.data.previewPath,
      success: () => {
        this.setData({ saving: false })
        wx.showToast({ title: '已保存到相册', icon: 'success' })
      },
      fail: (err) => {
        this.setData({ saving: false })
        if (err.errMsg && err.errMsg.indexOf('auth deny') >= 0) {
          wx.showModal({
            title: '提示',
            content: '需要相册权限才能保存图片，请在设置中开启',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting() }
          })
        }
      }
    })
  },

  cancelEdit() {
    this.setData({ hasImage: false, previewPath: '' })
    this.fixedPath = ''
  }
})
