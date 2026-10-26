Page({
  data: {
    tools: [
      {
        key: 'compress',
        icon: '🗜️',
        name: '图片压缩',
        desc: '减小体积 · 更快分享',
        url: '/pages/compress/compress'
      },
      {
        key: 'crop',
        icon: '✂️',
        name: '裁剪旋转',
        desc: '自由裁剪 · 比例旋转',
        url: '/pages/crop/crop'
      }
    ],
    showPrivacyModal: false
  },

  onLoad() {
    const agreed = wx.getStorageSync('privacyAgreed')
    if (!agreed) {
      this.setData({ showPrivacyModal: true })
    }
  },

  agreePrivacy() {
    wx.setStorageSync('privacyAgreed', true)
    this.setData({ showPrivacyModal: false })
    wx.showToast({ title: '欢迎使用', icon: 'success' })
  },

  rejectPrivacy() {
    wx.showModal({
      title: '需要同意隐私协议',
      content: '不同意隐私协议将无法使用本小程序',
      showCancel: false,
      success: () => {
        this.setData({ showPrivacyModal: true })
      }
    })
  },

  onPrivacyMaskTap() {
    // 点击遮罩不关闭，必须点按钮
  },

  openTool(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' })
  }
})
