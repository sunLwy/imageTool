// ============================================================
// JPEG EXIF 解析工具（共享模块）
// 提供：拍摄时间 DateTimeOriginal、方向 Orientation 的读取
// 使用方：stamp 页（时间水印）、compress 页（格式转码时的方向矫正）
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

// 读文件二进制 → EXIF（读取失败时兜底 orientation=1，不阻断流程）
function readExifP(path) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      success: (r) => resolve(readExif(r.data)),
      fail: () => resolve({ dateTime: null, orientation: 1 })
    })
  })
}

module.exports = {
  readExif,
  readExifP
}
