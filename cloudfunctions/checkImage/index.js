// 图片内容安全检测云函数
// 调用微信官方 security.imgSecCheck 同步检测，违规内容返回 risky
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const { base64, contentType } = event || {}

  if (!base64) {
    return { safe: false, reason: 'empty_image' }
  }

  try {
    await cloud.openapi.security.imgSecCheck({
      media: {
        contentType: contentType || 'image/jpeg',
        value: Buffer.from(base64, 'base64')
      }
    })
    // 接口未抛异常即内容正常
    return { safe: true }
  } catch (err) {
    // 87014 = 内容含有违法违规内容（risky content）
    if (err && (err.errCode === 87014 || err.errno === 87014)) {
      return { safe: false, risky: true, errCode: 87014 }
    }
    // 其他异常（网络、参数、额度等）交由前端判定为"检测不可用"
    return {
      safe: false,
      risky: false,
      errCode: err && (err.errCode || err.errno) || -1,
      errMsg: (err && err.errMsg) || String(err)
    }
  }
}
