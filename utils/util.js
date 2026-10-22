// 格式化文件大小
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

// 获取今日日期字符串
function getTodayString() {
  return new Date().toDateString()
}

module.exports = {
  formatSize,
  getTodayString
}
