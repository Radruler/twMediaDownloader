/**
 * Shared media extraction utility for Twitter tweet objects.
 * Extracts media (images, videos, gifs) from tweet_status, handling
 * extended_entities, entities, and unified_card/card.
 * Returns a list of { media_type, media_url }.
 */

/**
 * Extracts media from a tweet_status object.
 * @param {object} tweet_status
 * @returns {Array<{media_type: string, media_url: string}>}
 */
function extractMediaFromTweetStatus(tweet_status) {
  let source_media_infos = [];

  if (tweet_status.extended_entities && tweet_status.extended_entities.media) {
    source_media_infos = tweet_status.extended_entities.media;
  } else if (tweet_status.entities && tweet_status.entities.media) {
    source_media_infos = tweet_status.entities.media;
  } else {
    // Enhanced unified_card extraction: support both object and array forms of binding_values, and extract all media_entities
    try {
      let unified_card_string = null;
      if (
        tweet_status.card &&
        tweet_status.card.binding_values
      ) {
        if (Array.isArray(tweet_status.card.binding_values)) {
          // Array form (advertiser suite)
          const ucEntry = tweet_status.card.binding_values.find(
            v => v.key === 'unified_card' && v.value && v.value.string_value
          );
          if (ucEntry) unified_card_string = ucEntry.value.string_value;
        } else if (
          tweet_status.card.binding_values.unified_card &&
          tweet_status.card.binding_values.unified_card.string_value
        ) {
          // Object form (legacy)
          unified_card_string = tweet_status.card.binding_values.unified_card.string_value;
        }
      }
      if (unified_card_string) {
        let unified_card_info = JSON.parse(unified_card_string);
        if (
          unified_card_info &&
          unified_card_info.media_entities
        ) {
          // If component_objects.media_1 exists, use it for backward compatibility
          if (
            unified_card_info.component_objects &&
            unified_card_info.component_objects.media_1 &&
            unified_card_info.component_objects.media_1.data &&
            unified_card_info.component_objects.media_1.data.id
          ) {
            let media_id = unified_card_info.component_objects.media_1.data.id;
            if (unified_card_info.media_entities[media_id]) {
              source_media_infos.push(unified_card_info.media_entities[media_id]);
            }
          } else {
            // Otherwise, push all media_entities
            for (let key in unified_card_info.media_entities) {
              if (unified_card_info.media_entities.hasOwnProperty(key)) {
                source_media_infos.push(unified_card_info.media_entities[key]);
              }
            }
          }
        }
      }
    } catch (error) {
      source_media_infos = [];
    }
  }

  return source_media_infos.map((source_media_info) => {
    let media_type = null;
    let media_url = null;
    const get_max_bitrate_video_info = (video_infos) => {
      return video_infos
        .filter(video_info => video_info.content_type === 'video/mp4')
        .reduce((video_info_max_bitrate, video_info) => {
          return (video_info_max_bitrate.bitrate < video_info.bitrate) ? video_info : video_info_max_bitrate;
        }, { bitrate: -1 });
    };

    switch (source_media_info.type) {
      case 'photo':
        media_type = 'image';
        try {
          // Prefer ?format=...&name=orig for best quality
          media_url = source_media_info.media_url_https.replace(/\.([^.]+)$/, '?format=$1&name=orig');
        } catch (error) {}
        break;
      case 'animated_gif':
        media_type = 'gif';
        media_url = get_max_bitrate_video_info((source_media_info.video_info || {}).variants || []).url;
        break;
      case 'video':
        media_type = 'video';
        media_url = get_max_bitrate_video_info((source_media_info.video_info || {}).variants || []).url;
        break;
    }

    return {
      media_type,
      media_url,
    };
  }).filter(media => (media.media_type !== null) && media.media_url);
}

// UMD export for compatibility with both browser and Node/CommonJS
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = { extractMediaFromTweetStatus };
} else {
  window.extractMediaFromTweetStatus = extractMediaFromTweetStatus;
}
