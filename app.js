App({
  onLaunch() {
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
