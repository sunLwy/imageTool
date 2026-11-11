const { getPrivacySettingP, openPrivacyContract } = require('../../utils/privacy')

Page({
  // 转发给好友：落地页统一为首页，用户点开即可看到全部工具
  onShareAppMessage() {
    return {
      title: '图小帮｜图片压缩、裁剪、加水印、九宫格切图',
      path: '/pages/index/index'
    };
  },

  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: '图小帮｜图片压缩、裁剪、加水印、九宫格切图'
    };
  },

  data: {
    tools: [
      {
        key: 'compress',
        icon: '/images/icon-compress.png',
        name: '图片压缩',
        desc: '减小体积 · 更快分享',
        url: '/pages/compress/compress'
      },
      {
        key: 'crop',
        icon: '/images/icon-crop.png',
        name: '裁剪旋转',
        desc: '自由裁剪 · 比例旋转',
        url: '/pages/crop/crop'
      },
      {
        key: 'stamp',
        icon: '/images/icon-stamp.png',
        name: '时间水印',
        desc: '照片加拍摄日期',
        url: '/pages/stamp/stamp'
      },
      {
        key: 'gridcut',
        icon: '/images/icon-gridcut.png',
        name: '九宫格切图',
        desc: '一张照片切 9 张发圈',
        url: '/pages/gridcut/gridcut'
      }
    ],
    showPrivacyModal: false,
    privacyContractName: '《隐私保护指引》'
  },

  // 非渲染状态：null=初始化中/低版本放行，true=已同意，false=曾拒绝
  privacyAgreed: null,

  async onLoad() {
    // 低版本基础库（<2.32.3）没有隐私校验，无需弹窗
    if (!wx.getPrivacySetting) return

    const setting = await getPrivacySettingP()
    if (setting.needAuthorization) {
      // 微信侧无「已同意」记录 → 弹自定义说明弹窗，同意按钮走官方授权组件
      this.setData({
        showPrivacyModal: true,
        privacyContractName: setting.privacyContractName || '《隐私保护指引》'
      })
    } else {
      // 已同意过（含后台指引更新但无新增收集项的老用户）
      this.privacyAgreed = true
    }
  },

  // 官方授权按钮回调：用户点击 open-type="agreePrivacyAuthorization" 的按钮，
  // 微信已记录同意状态，这里只负责收起弹窗
  onAgreePrivacy() {
    this.privacyAgreed = true
    wx.setStorageSync('privacyAgreed', true)
    this.setData({ showPrivacyModal: false })
    wx.showToast({ title: '欢迎使用', icon: 'success' })
  },

  // 不同意：给出出口（可继续浏览首页），点工具时再引导
  rejectPrivacy() {
    this.privacyAgreed = false
    this.setData({ showPrivacyModal: false })
    wx.showToast({ title: '不同意协议将无法使用图片工具', icon: 'none' })
  },

  // 查看完整《用户隐私保护指引》（微信内置页面）
  viewPrivacyContract() {
    openPrivacyContract()
  },

  onPrivacyMaskTap() {
    // 点击遮罩不关闭，必须点按钮
  },

  openTool(e) {
    // 弹窗展示中不跳转
    if (this.data.showPrivacyModal) return
    // 曾拒绝：重新弹窗引导同意，不跳转
    if (this.privacyAgreed === false) {
      this.setData({ showPrivacyModal: true })
      return
    }
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' })
  }
})
