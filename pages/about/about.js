const { openPrivacyContract } = require('../../utils/privacy')

Page({
  // 转发给好友：落地页统一为首页，用户点开即可看到全部工具
  onShareAppMessage() {
    return {
      title: '图小帮｜免费图片处理工具箱',
      path: '/pages/index/index'
    };
  },

  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: '图小帮｜免费图片处理工具箱'
    };
  },

  // 打开微信内置的《用户隐私保护指引》页面
  viewPrivacyContract() {
    openPrivacyContract()
  },
})
