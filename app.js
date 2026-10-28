App({
  onLaunch() {
    // 初始化微信云开发（图片内容安全检测云函数依赖）
    // 开通云开发后，把下面的环境 ID 替换为你自己的云环境 ID（云开发控制台首页可见）
    if (wx.cloud) {
      wx.cloud.init({
        env: 'YOUR_CLOUD_ENV_ID',
        traceUser: true
      })
    }

    // 展示本地存储能力
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)
  },

  globalData: {
    // 广告位ID——上线前替换成你自己的
    adUnitIds: {
      bannerAd: 'adunit-xxxxxxxxxxxx',       // 底部Banner
      rewardedVideoAd: 'adunit-xxxxxxxxxxxx' // 激励视频
    },
    // 免费用户今日可用压缩次数（剩余次数存本地）
    freeDailyLimit: 3
  }
})
