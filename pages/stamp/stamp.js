// ============================================================
// 照片时间水印：自动读取 EXIF 拍摄时间并绘制到照片（冲印日期戳）
// 支持单张精细模式（选1张）与批量模式（选2-9张，统一参数）
// ============================================================

// 从 JPEG 二进制解析 EXIF 拍摄时间(DateTimeOriginal)与方向(Orientation)
function readExif(buffer) {
  const result = { dateTime: null, orientation: 1 }
  try {
    const dv = new DataView(buffer)
    if (buffer.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return result // 非 JPEG

    let offset = 2
    while (offset + 4 < buffer.byteLength) {
      const marker = dv.getUint16(offset)
      if (marker === 0xFFE1) { // APP1
        const segLen = dv.getUint16(offset + 2)
        if (dv.getUint32(offset + 4) === 0x45786966 && dv.getUint16(offset + 8) === 0x0000) {
          parseTiff(dv, offset + 10, result)
          return result
        }
        offset += 2 + segLen
      } else if (marker === 0xFFDA || marker === 0xFFD9) {
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
  const little = bo === 0x4949 // 'II' 小端
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

  const ifd0 = tiffStart + g32(tiffStart + 4)
  const n0 = g16(ifd0)
  let subIfdOffset = null
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12
    const tag = g16(e)
    if (tag === 0x8769) subIfdOffset = g32(e + 8)
    else if (tag === 0x0112) result.orientation = g16(e + 8)
    else if (tag === 0x0132 && !result.dateTime) result.dateTime = readAscii(e)
  }

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

// 读文件二进制 → EXIF
function readExifP(path) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      success: (r) => resolve(readExif(r.data)),
      fail: () => resolve({ dateTime: null, orientation: 1 })
    })
  })
}

// 解析 EXIF 时间，识别不到用兜底（当天日期）
function parseExifDate(exif, fbDate, fbTime) {
  let date = fbDate, time = fbTime, detected = false
  if (exif.dateTime && exif.dateTime.length >= 10) {
    const m = exif.dateTime.match(/^(\d{4}):(\d{2}):(\d{2})(?:\s+(\d{2}):(\d{2}))?/)
    if (m) {
      date = `${m[1]}-${m[2]}-${m[3]}`
      time = m[4] ? `${m[4]}:${m[5]}` : '00:00'
      detected = true
    }
  }
  return { date, time, detected, orientation: exif.orientation || 1 }
}

function getImageInfoP(path) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src: path, success: resolve, fail: reject })
  })
}

Page({
  data: {
    // 单张模式
    hasImage: false,
    previewPath: '',

    // 批量模式
    batchMode: false,
    jobs: [],            // { src, date, time, detected, dateText, orientation, outPath, status }
    processing: false,
    doneCount: 0,
    batchDone: false,
    batchSaved: false,

    // 批量：存在未识别时间照片时，手动时间只作用于这些照片
    showFallbackPicker: false,
    fbDate: '',
    fbTime: '',
    fbCount: 0,

    // 选项
    stampStyle: 'classic',   // classic 经典冲印 / minimal 简约
    showTime: false,         // true 日期+时间 / false 仅日期
    fontSizeLevel: 'm',      // s 小 / m 中 / l 大
    position: 'rb',          // lt rt lb rb
    stampDate: '',
    stampTime: '',
    todayDate: '',
    todayTime: '',
    exifDetected: false,

    saving: false,
    rendering: false
  },

  fixedPath: '',
  fw: 0,
  fh: 0,
  renderToken: 0,

  onLoad() {
    const now = new Date()
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const t = `${pad(now.getHours())}:${pad(now.getMinutes())}`
    this.setData({ stampDate: d, stampTime: t, todayDate: d, todayTime: t })
  },

  // ============ 选图（最多9张，原图保留EXIF） ============
  chooseImage() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath)
        if (paths.length === 1) {
          this.enterSingle(paths[0])
        } else {
          this.enterBatch(paths)
        }
      }
    })
  },

  // ---------- 单张模式 ----------
  enterSingle(path) {
    wx.showLoading({ title: '读取中...' })
    Promise.resolve()
      .then(async () => {
        const exif = await readExifP(path)
        const parsed = parseExifDate(exif, this.data.todayDate, this.data.todayTime)
        const info = await getImageInfoP(path)
        const norm = await this.normalizeP(path, info.width, info.height, parsed.orientation)
        wx.hideLoading()
        this.fixedPath = norm.fixedPath
        this.fw = norm.fw
        this.fh = norm.fh
        this.setData({
          batchMode: false,
          hasImage: true,
          stampDate: parsed.date,
          stampTime: parsed.time,
          exifDetected: parsed.detected
        })
        this.render()
        if (!parsed.detected) {
          wx.showToast({ title: '未检测到拍摄时间，已用今天日期', icon: 'none' })
        }
      })
      .catch(() => {
        wx.hideLoading()
        wx.showToast({ title: '图片读取失败', icon: 'none' })
      })
  },

  // ---------- 批量模式 ----------
  async enterBatch(paths) {
    wx.showLoading({ title: '读取照片信息...' })
    const jobs = paths.map((p) => ({ src: p, date: '', time: '', detected: false, dateText: '读取中…', orientation: 1, outPath: '', status: 'pending' }))
    this.setData({ batchMode: true, hasImage: false, jobs, processing: false, batchDone: false, batchSaved: false, doneCount: 0 })

    for (let i = 0; i < jobs.length; i++) {
      const exif = await readExifP(jobs[i].src)
      const parsed = parseExifDate(exif, this.data.todayDate, this.data.todayTime)
      jobs[i].date = parsed.date
      jobs[i].time = parsed.time
      jobs[i].detected = parsed.detected
      jobs[i].orientation = parsed.orientation
      jobs[i].dateText = parsed.detected ? parsed.date : parsed.date + '（今天）'
    }
    wx.hideLoading()
    const fbCount = jobs.filter((j) => !j.detected).length
    this.setData({
      jobs: jobs.slice(),
      showFallbackPicker: fbCount > 0,
      fbCount: fbCount,
      fbDate: this.data.todayDate,
      fbTime: this.data.todayTime
    })
    if (fbCount > 0) {
      wx.showToast({ title: `${fbCount} 张未识别时间，可在下方修改`, icon: 'none' })
    }
  },

  // 批量：手动时间只作用于未识别到拍摄时间的照片
  onFbDateChange(e) {
    const fbDate = e.detail.value
    const jobs = this.data.jobs.map((j) => {
      if (j.detected) return j
      return Object.assign({}, j, { date: fbDate, dateText: fbDate })
    })
    this.setData({ fbDate, jobs })
  },
  onFbTimeChange(e) {
    const fbTime = e.detail.value
    const jobs = this.data.jobs.map((j) => {
      if (j.detected) return j
      return Object.assign({}, j, { time: fbTime })
    })
    this.setData({ fbTime, jobs })
  },

  // 按 EXIF Orientation 把图片转成正向 JPG
  normalizeP(src, w, h, orientation) {
    return new Promise((resolve) => {
      let cw = w, ch = h, rot = 0
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
          success: (res) => resolve({ fixedPath: res.tempFilePath, fw: cw, fh: ch }),
          fail: () => resolve({ fixedPath: src, fw: cw, fh: ch })
        })
      }
      image.onerror = () => resolve({ fixedPath: src, fw: cw, fh: ch })
      image.src = src
    })
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

  placeBox(position, bw, bh, margin, fw, fh) {
    const x = position[0] === 'r' ? fw - margin - bw : margin
    const y = position[1] === 'b' ? fh - margin - bh : margin
    return { x, y }
  },

  // 画时间戳并导出 outPath（opts: {date,time,showTime,stampStyle,fontSizeLevel,position}）
  drawStampP(fixedPath, fw, fh, opts) {
    return new Promise((resolve, reject) => {
      const d = opts.date.replace(/-/g, '.')
      const text = opts.showTime ? `${d} ${opts.time}` : d

      const canvas = wx.createOffscreenCanvas({ type: '2d', width: fw, height: fh })
      const ctx = canvas.getContext('2d')
      const image = canvas.createImage()
      image.onload = () => {
        ctx.drawImage(image, 0, 0, fw, fh)

        const short = Math.min(fw, fh)
        const sizeScale = { s: 0.024, m: 0.032, l: 0.044 }[opts.fontSizeLevel]
        const fs = Math.round(short * sizeScale)
        const margin = Math.round(short * 0.035)

        if (opts.stampStyle === 'classic') {
          ctx.font = `bold ${fs}px "Courier New", monospace`
          ctx.textBaseline = 'alphabetic'
          const tw = ctx.measureText(text).width
          const box = this.placeBox(opts.position, tw, fs, margin, fw, fh)
          ctx.lineJoin = 'round'
          ctx.lineWidth = Math.max(2, fs / 9)
          ctx.strokeStyle = 'rgba(0,0,0,0.85)'
          ctx.strokeText(text, box.x, box.y + fs * 0.82)
          ctx.fillStyle = '#ffb347'
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
          const box = this.placeBox(opts.position, bw, bh, margin, fw, fh)
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
          success: (res) => resolve(res.tempFilePath),
          fail: reject
        })
      }
      image.onerror = reject
      image.src = fixedPath
    })
  },

  // 单张：按当前选项重画预览
  render() {
    if (!this.fixedPath) return
    const token = ++this.renderToken
    this.setData({ rendering: true })
    const opts = {
      date: this.data.stampDate,
      time: this.data.stampTime,
      showTime: this.data.showTime,
      stampStyle: this.data.stampStyle,
      fontSizeLevel: this.data.fontSizeLevel,
      position: this.data.position
    }
    this.drawStampP(this.fixedPath, this.fw, this.fh, opts)
      .then((outPath) => {
        if (token !== this.renderToken) return
        this.setData({ previewPath: outPath, rendering: false })
      })
      .catch(() => {
        if (token !== this.renderToken) return
        this.setData({ rendering: false })
        wx.showToast({ title: '生成失败', icon: 'none' })
      })
  },

  // ============ 批量：开始处理（串行渲染） ============
  async startBatch() {
    if (this.data.processing) return
    this.setData({ processing: true, doneCount: 0 })
    const jobs = this.data.jobs.slice()
    let ok = 0
    for (let i = 0; i < jobs.length; i++) {
      try {
        const info = await getImageInfoP(jobs[i].src)
        const norm = await this.normalizeP(jobs[i].src, info.width, info.height, jobs[i].orientation)
        const outPath = await this.drawStampP(norm.fixedPath, norm.fw, norm.fh, {
          date: jobs[i].date,
          time: jobs[i].time,
          showTime: this.data.showTime,
          stampStyle: this.data.stampStyle,
          fontSizeLevel: this.data.fontSizeLevel,
          position: this.data.position
        })
        jobs[i].outPath = outPath
        jobs[i].status = 'done'
        ok++
      } catch (e) {
        jobs[i].status = 'error'
      }
      this.setData({ jobs: jobs.slice(), doneCount: i + 1 })
    }
    this.setData({ processing: false, batchDone: true, batchSaved: false })
    wx.showToast({ title: `完成 ${ok}/${jobs.length} 张`, icon: 'none' })
  },

  // ============ 批量：保存全部 ============
  async saveBatch() {
    if (this.data.saving) return
    const okJobs = this.data.jobs.filter((j) => j.status === 'done' && j.outPath)
    if (!okJobs.length) {
      wx.showToast({ title: '没有可保存的图片', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    let saved = 0
    for (let i = 0; i < okJobs.length; i++) {
      try {
        await new Promise((resolve, reject) => {
          wx.saveImageToPhotosAlbum({
            filePath: okJobs[i].outPath,
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
    this.setData({ saving: false, batchSaved: true })
    wx.showToast({ title: `已保存 ${saved} 张到相册`, icon: 'success' })
  },

  // ============ 选项交互（单张 & 批量共用） ============
  setStyle(e) {
    this.setData({ stampStyle: e.currentTarget.dataset.value })
    if (!this.data.batchMode) this.render()
  },
  setFormat(e) {
    this.setData({ showTime: e.currentTarget.dataset.value === 'datetime' })
    if (!this.data.batchMode) this.render()
  },
  setFontSize(e) {
    this.setData({ fontSizeLevel: e.currentTarget.dataset.level })
    if (!this.data.batchMode) this.render()
  },
  setPosition(e) {
    this.setData({ position: e.currentTarget.dataset.value })
    if (!this.data.batchMode) this.render()
  },
  onDateChange(e) {
    this.setData({ stampDate: e.detail.value })
    this.render()
  },
  onTimeChange(e) {
    this.setData({ stampTime: e.detail.value })
    this.render()
  },

  // ============ 单张保存 ============
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
    this.setData({
      hasImage: false,
      previewPath: '',
      batchMode: false,
      jobs: [],
      processing: false,
      batchDone: false,
      batchSaved: false,
      doneCount: 0,
      showFallbackPicker: false,
      fbCount: 0
    })
    this.fixedPath = ''
  }
})
