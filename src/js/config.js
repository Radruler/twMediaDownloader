// config.js - Centralized configuration and constants for the extension

// Global options and feature toggles
window.CONFIG = {
  // Feature toggles and limits
  OPTIONS: {
    IMAGE_DOWNLOAD_LINK: true,
    VIDEO_DOWNLOAD_LINK: true,
    OPEN_MEDIA_LINK_BY_DEFAULT: false,
    ENABLE_FILTER: true,
    DOWNLOAD_SIZE_LIMIT_MB: 500,
    ENABLE_VIDEO_DOWNLOAD: true,
    AUTO_CONTINUE: true,
    OPERATION: true,
    QUICK_LOAD_GIF: true,
    DEFAULT_LIMIT_TWEET_NUMBER: 0,
    DEFAULT_SUPPORT_IMAGE: true,
    DEFAULT_SUPPORT_GIF: true,
    DEFAULT_SUPPORT_VIDEO: true,
    DEFAULT_INCLUDE_RETWEETS: false,
    DEFAULT_SUPPORT_NOMEDIA: false,
    DEFAULT_DRY_RUN: false,
    ENABLE_ZIPREQUEST: false,
    INCOGNITO_MODE: false,
    TWITTER_OAUTH_POPUP: true,
    TWITTER_API_DELAY_TIME_MS: 1100,
    TWITTER_API2_DELAY_TIME_MS: 5100
  },

  // Language-dependent UI strings (English and Japanese)
  UI_STRINGS: {
    en: {
      DOWNLOAD_BUTTON_TEXT: "⇩",
      DOWNLOAD_BUTTON_TEXT_LONG: "Media ⇩",
      DOWNLOAD_BUTTON_HELP_TEXT: "Download images/videos from timeline",
      DIALOG_TWEET_ID_RANGE_HEADER: "Download Tweet ID range (There is no limit when left blank)",
      DIALOG_TWEET_ID_RANGE_MARK: "< ID <",
      DIALOG_TWEET_ID_PLACEHOLDER_LEFT: "Since ID or datetime",
      DIALOG_TWEET_ID_PLACEHOLDER_RIGHT: "Until ID or datetime",
      DIALOG_LIMIT_TWEET_NUMBER_TEXT: "Limit",
      DIALOG_BUTTON_START_TEXT: "Start",
      DIALOG_BUTTON_STOP_TEXT: "Stop",
      DIALOG_BUTTON_CLOSE_TEXT: "Close",
      CHECKBOX_IMAGE_TEXT: "Images",
      CHECKBOX_GIF_TEXT: "Videos(GIF)",
      CHECKBOX_VIDEO_TEXT: "Videos",
      CHECKBOX_NOMEDIA_TEXT: "No media",
      CHECKBOX_INCLUDE_RETWEETS: "include RTs",
      CHECKBOX_DRY_RUN: "Dry run",
      CHECKBOX_ALERT: "Please check the checkbox of at least one media type !",
      IMAGE_DOWNLOAD_LINK_TEXT: "IMG⇩",
      VIDEO_DOWNLOAD_LINK_TEXT: "MP4⇩",
      DOWNLOAD_MEDIA_TITLE: "Download",
      OPEN_MEDIA_LINK: "Open media links",
      LIKES_DOWNLOAD_BUTTON_TEXT_LONG: "Likes ⇩",
      LIKES_DOWNLOAD_BUTTON_HELP_TEXT: "Download images/videos from Likes-timeline",
      DIALOG_DATE_RANGE_HEADER_LIKES: 'Download "Likes" date-time range (There is no limit when left blank)',
      DIALOG_DATE_RANGE_HEADER_NOTIFICATIONS: 'Download "Notifications" date-time range (There is no limit when left blank)',
      DIALOG_DATE_RANGE_HEADER_BOOKMARKS: 'Download "Bookmarks" date-time range (There is no limit when left blank)',
      DIALOG_DATE_RANGE_MARK: "< DATETIME <",
      DIALOG_DATE_PLACEHOLDER_LEFT: "Since datetime",
      DIALOG_DATE_PLACEHOLDER_RIGHT: "Until datetime",
      DIALOG_DUPLICATE_WARNING: "Close the download dialog and reopen it",
      MENTIONS_DOWNLOAD_BUTTON_TEXT_LONG: "Mentions ⇩",
      MENTIONS_DOWNLOAD_BUTTON_HELP_LONG: "Download images/videos of mentions from Notifications-timeline",
      BOOKMARKS_DOWNLOAD_BUTTON_HELP_LONG: "Download images/videos of mentions from Bookmarks-timeline"
    },
    ja: {
      DOWNLOAD_BUTTON_TEXT: "⇩",
      DOWNLOAD_BUTTON_TEXT_LONG: "メディア ⇩",
      DOWNLOAD_BUTTON_HELP_TEXT: "タイムラインの画像/動画を保存",
      DIALOG_TWEET_ID_RANGE_HEADER: "対象 Tweet ID 範囲 (空欄時は制限なし)",
      DIALOG_TWEET_ID_RANGE_MARK: "＜ ID ＜",
      DIALOG_TWEET_ID_PLACEHOLDER_LEFT: "下限IDまたは日時",
      DIALOG_TWEET_ID_PLACEHOLDER_RIGHT: "上限IDまたは日時",
      DIALOG_LIMIT_TWEET_NUMBER_TEXT: "制限数",
      DIALOG_BUTTON_START_TEXT: "開始",
      DIALOG_BUTTON_STOP_TEXT: "停止",
      DIALOG_BUTTON_CLOSE_TEXT: "閉じる",
      CHECKBOX_IMAGE_TEXT: "画像",
      CHECKBOX_GIF_TEXT: "動画(GIF)",
      CHECKBOX_VIDEO_TEXT: "動画",
      CHECKBOX_NOMEDIA_TEXT: "メディア無し",
      CHECKBOX_INCLUDE_RETWEETS: "RTを含む",
      CHECKBOX_DRY_RUN: "走査のみ",
      CHECKBOX_ALERT: "少なくとも一つのメディアタイプにはチェックを入れて下さい",
      IMAGE_DOWNLOAD_LINK_TEXT: "画像⇩",
      VIDEO_DOWNLOAD_LINK_TEXT: "MP4⇩",
      DOWNLOAD_MEDIA_TITLE: "ダウンロード",
      OPEN_MEDIA_LINK: "メディアを開く",
      LIKES_DOWNLOAD_BUTTON_TEXT_LONG: "いいね ⇩",
      LIKES_DOWNLOAD_BUTTON_HELP_TEXT: "『いいね』をしたツイートの画像/動画を保存",
      DIALOG_DATE_RANGE_HEADER_LIKES: "対象『いいね』日時範囲 (空欄時は制限なし)",
      DIALOG_DATE_RANGE_HEADER_NOTIFICATIONS: "対象『通知』日時範囲 (空欄時は制限なし)",
      DIALOG_DATE_RANGE_HEADER_BOOKMARKS: "対象『ブックマーク』日時範囲 (空欄時は制限なし)",
      DIALOG_DATE_RANGE_MARK: "＜ 日時 ＜",
      DIALOG_DATE_PLACEHOLDER_LEFT: "下限日時",
      DIALOG_DATE_PLACEHOLDER_RIGHT: "上限日時",
      DIALOG_DUPLICATE_WARNING: "ダウンロードダイアログを閉じてから開き直してください",
      MENTIONS_DOWNLOAD_BUTTON_TEXT_LONG: "@ツイート ⇩",
      MENTIONS_DOWNLOAD_BUTTON_HELP_LONG: "通知(@ツイート)の画像/動画を保存",
      BOOKMARKS_DOWNLOAD_BUTTON_HELP_LONG: "ブックマークの画像/動画を保存"
    }
  },

  // API endpoint constants
  API_ENDPOINTS: {
    API_RATE_LIMIT_STATUS: "https://api.x.com/1.1/application/rate_limit_status.json",
    API_VIDEO_CONFIG_BASE: "https://api.x.com/1.1/videos/tweet/config/#TWEETID#.json",
    API_TWEET_SHOW_BASE: "https://api.x.com/1.1/statuses/show.json?include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&skip_status=1&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_reply_count=1&tweet_mode=extended&trim_user=false&include_ext_media_color=true&id=#TWEETID#",
    GIF_VIDEO_URL_BASE: "https://video.twimg.com/tweet_video/#VIDEO_ID#.mp4"
  },

  // Other global constants
  LOADING_IMAGE_URL: "https://abs.twimg.com/a/1460504487/img/t1/spinner-rosetta-gray-32x32.gif"
};
