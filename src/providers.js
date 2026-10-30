// Official platform integrations: OAuth connection and publishing for
// Facebook Pages and Instagram professional accounts (Meta Graph API),
// TikTok (Login Kit + Content Posting API) and YouTube (Data API v3).

const GRAPH = 'https://graph.facebook.com/v23.0';
const TIKTOK_API = 'https://open.tiktokapis.com/v2';
const META_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management',
  'instagram_basic', 'instagram_content_publish',
];
const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export const CONNECTABLE = {
  facebook: { provider: 'meta', label: 'Facebook Page' },
  instagram: { provider: 'meta', label: 'Instagram professional account' },
  tiktok: { provider: 'tiktok', label: 'TikTok account' },
  youtube: { provider: 'google', label: 'YouTube channel' },
};

export class ProviderError extends Error {
  constructor(message, { expired = false } = {}) {
    super(message);
    this.expired = expired;
  }
}

export function providerConfigured(env, provider) {
  if (provider === 'meta') return Boolean(env.META_APP_ID && env.META_APP_SECRET);
  if (provider === 'tiktok') return Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
  if (provider === 'google') return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return false;
}

export function redirectUri(env, provider) {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/api/oauth/${provider}/callback`;
}

export function authorizeUrl(env, platform, state) {
  const { provider } = CONNECTABLE[platform];
  const redirect = redirectUri(env, provider);
  if (provider === 'meta') {
    return `https://www.facebook.com/v23.0/dialog/oauth?${new URLSearchParams({
      client_id: env.META_APP_ID, redirect_uri: redirect, state, response_type: 'code', scope: META_SCOPES.join(','),
    })}`;
  }
  if (provider === 'tiktok') {
    return `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY, redirect_uri: redirect, state, response_type: 'code', scope: TIKTOK_SCOPES.join(','),
    })}`;
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, state, response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  })}`;
}

async function readProviderJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

function secondsFromNow(seconds) {
  return seconds ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null;
}

// ---------- Meta (Facebook Pages + Instagram) ----------

async function graph(path, { method = 'GET', params = {}, token } = {}) {
  const query = new URLSearchParams({ ...params, ...(token ? { access_token: token } : {}) });
  const url = method === 'GET' ? `${GRAPH}${path}?${query}` : `${GRAPH}${path}`;
  const response = await fetch(url, method === 'GET' ? {} : { method, body: query });
  const data = await readProviderJson(response);
  if (!response.ok || data.error) {
    const error = data.error || {};
    throw new ProviderError(error.error_user_msg || error.message || `Meta request failed (${response.status})`, {
      expired: error.code === 190 || error.code === 102,
    });
  }
  return data;
}

async function completeMeta(env, platform, code) {
  const shortLived = await graph('/oauth/access_token', {
    params: { client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: redirectUri(env, 'meta'), code },
  });
  const longLived = await graph('/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET,
      fb_exchange_token: shortLived.access_token,
    },
  });
  const pages = await graph('/me/accounts', {
    token: longLived.access_token,
    params: {
      limit: '100',
      fields: 'id,name,link,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
    },
  });
  const scopes = META_SCOPES.join(',');
  if (platform === 'facebook') {
    const accounts = (pages.data || []).map((page) => ({
      platform, externalId: page.id, displayName: page.name, avatarUrl: page.picture?.data?.url || '',
      profileUrl: page.link || `https://www.facebook.com/${page.id}`, accessToken: page.access_token,
      refreshToken: null, expiresAt: null, scopes, metadata: { pageId: page.id },
    }));
    if (!accounts.length) throw new ProviderError('No Facebook Pages were shared. Reconnect and select at least one Page you manage.');
    return accounts;
  }
  const accounts = (pages.data || []).filter((page) => page.instagram_business_account).map((page) => {
    const ig = page.instagram_business_account;
    return {
      platform, externalId: ig.id, displayName: ig.username ? `@${ig.username}` : ig.name || 'Instagram account',
      avatarUrl: ig.profile_picture_url || '', profileUrl: ig.username ? `https://www.instagram.com/${ig.username}/` : '',
      accessToken: page.access_token, refreshToken: null, expiresAt: null, scopes,
      metadata: { pageId: page.id, pageName: page.name },
    };
  });
  if (!accounts.length) {
    throw new ProviderError('No Instagram professional account is linked to the Facebook Pages you shared. Link the Instagram account to a Page in Meta Business Suite, then reconnect.');
  }
  return accounts;
}

async function publishFacebook({ account, post, media }) {
  const pageId = account.externalId;
  const token = account.accessToken;
  const video = media.find((item) => item.type === 'video');
  if (video) {
    const result = await graph(`/${pageId}/videos`, {
      method: 'POST', token, params: { file_url: video.url, description: post.content, ...(post.title ? { title: post.title } : {}) },
    });
    return { status: 'published', externalId: result.id, externalUrl: `https://www.facebook.com/${pageId}/videos/${result.id}` };
  }
  const images = media.filter((item) => item.type === 'image');
  if (images.length === 1) {
    const result = await graph(`/${pageId}/photos`, { method: 'POST', token, params: { url: images[0].url, caption: post.content } });
    const id = result.post_id || result.id;
    return { status: 'published', externalId: id, externalUrl: `https://www.facebook.com/${id}` };
  }
  const params = { message: post.content };
  if (images.length > 1) {
    const uploaded = [];
    for (const image of images.slice(0, 10)) {
      uploaded.push(await graph(`/${pageId}/photos`, { method: 'POST', token, params: { url: image.url, published: 'false' } }));
    }
    uploaded.forEach((photo, index) => { params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: photo.id }); });
  }
  const result = await graph(`/${pageId}/feed`, { method: 'POST', token, params });
  return { status: 'published', externalId: result.id, externalUrl: `https://www.facebook.com/${result.id}` };
}

async function containerStatus(id, token) {
  const result = await graph(`/${id}`, { token, params: { fields: 'status_code,status' } });
  if (result.status_code === 'ERROR' || result.status_code === 'EXPIRED') {
    throw new ProviderError(`Instagram could not process the media: ${result.status || result.status_code}`);
  }
  return result.status_code === 'FINISHED' || result.status_code === 'PUBLISHED';
}

async function publishInstagram({ account, post, media, providerState }) {
  const igId = account.externalId;
  const token = account.accessToken;
  const state = { ...providerState };
  const items = media.filter((item) => item.type === 'image' || item.type === 'video').slice(0, 10);
  if (!items.length) throw new ProviderError('Instagram posts need at least one image or video.');

  if (!state.containerId && !state.children) {
    if (items.length === 1) {
      const item = items[0];
      const params = item.type === 'video'
        ? { media_type: 'REELS', video_url: item.url, caption: post.content, share_to_feed: 'true' }
        : { image_url: item.url, caption: post.content };
      state.containerId = (await graph(`/${igId}/media`, { method: 'POST', token, params })).id;
    } else {
      state.children = [];
      for (const item of items) {
        const params = item.type === 'video'
          ? { media_type: 'VIDEO', video_url: item.url, is_carousel_item: 'true' }
          : { image_url: item.url, is_carousel_item: 'true' };
        state.children.push((await graph(`/${igId}/media`, { method: 'POST', token, params })).id);
      }
    }
  }
  if (state.children && !state.containerId) {
    for (const child of state.children) {
      if (!(await containerStatus(child, token))) return { status: 'processing', providerState: state };
    }
    state.containerId = (await graph(`/${igId}/media`, {
      method: 'POST', token, params: { media_type: 'CAROUSEL', children: state.children.join(','), caption: post.content },
    })).id;
  }
  if (!(await containerStatus(state.containerId, token))) return { status: 'processing', providerState: state };
  const published = await graph(`/${igId}/media_publish`, { method: 'POST', token, params: { creation_id: state.containerId } });
  let externalUrl = '';
  try { externalUrl = (await graph(`/${published.id}`, { token, params: { fields: 'permalink' } })).permalink || ''; } catch {}
  return { status: 'published', externalId: published.id, externalUrl, providerState: state };
}

// ---------- TikTok ----------

async function tiktokToken(env, params) {
  const response = await fetch(`${TIKTOK_API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, ...params }),
  });
  const data = await readProviderJson(response);
  if (!response.ok || data.error || !data.access_token) {
    throw new ProviderError(data.error_description || data.error || `TikTok sign-in failed (${response.status})`, { expired: true });
  }
  return data;
}

async function tiktok(path, token, body) {
  const response = await fetch(`${TIKTOK_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await readProviderJson(response);
  const code = data.error?.code;
  if (!response.ok || (code && code !== 'ok')) {
    throw new ProviderError(data.error?.message || `TikTok request failed (${response.status})`, {
      expired: code === 'access_token_invalid' || code === 'scope_not_authorized',
    });
  }
  return data.data || {};
}

async function completeTikTok(env, code) {
  const token = await tiktokToken(env, { code, grant_type: 'authorization_code', redirect_uri: redirectUri(env, 'tiktok') });
  const info = await tiktok('/user/info/?fields=open_id,display_name,avatar_url', token.access_token);
  const user = info.user || {};
  return [{
    platform: 'tiktok', externalId: token.open_id || user.open_id, displayName: user.display_name || 'TikTok account',
    avatarUrl: user.avatar_url || '', profileUrl: '', accessToken: token.access_token, refreshToken: token.refresh_token,
    expiresAt: secondsFromNow(token.expires_in), scopes: token.scope || TIKTOK_SCOPES.join(','),
    metadata: { refreshExpiresAt: secondsFromNow(token.refresh_expires_in) },
  }];
}

async function publishTikTok({ account, post, media, providerState }) {
  const token = account.accessToken;
  const state = { ...providerState };
  if (!state.publishId) {
    const creator = await tiktok('/post/publish/creator_info/query/', token, {});
    const allowed = creator.privacy_level_options || [];
    const wanted = post.options?.tiktokPrivacy || 'PUBLIC_TO_EVERYONE';
    const privacy = allowed.includes(wanted) ? wanted : null;
    if (!privacy) {
      throw new ProviderError(`TikTok does not allow "${wanted}" for this account. Allowed: ${allowed.join(', ') || 'none'}. Unaudited TikTok apps can only post as SELF_ONLY.`);
    }
    const video = media.find((item) => item.type === 'video');
    const images = media.filter((item) => item.type === 'image').slice(0, 35);
    if (video) {
      const result = await tiktok('/post/publish/video/init/', token, {
        post_info: { title: post.content.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
        source_info: { source: 'PULL_FROM_URL', video_url: video.url },
      });
      state.publishId = result.publish_id;
    } else if (images.length) {
      const result = await tiktok('/post/publish/content/init/', token, {
        post_info: { title: (post.title || post.content).slice(0, 90), description: post.content.slice(0, 4000), privacy_level: privacy },
        source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: images.map((item) => item.url) },
        post_mode: 'DIRECT_POST', media_type: 'PHOTO',
      });
      state.publishId = result.publish_id;
    } else {
      throw new ProviderError('TikTok posts need a video or at least one image.');
    }
  }
  const status = await tiktok('/post/publish/status/fetch/', token, { publish_id: state.publishId });
  if (status.status === 'FAILED') throw new ProviderError(`TikTok rejected the post: ${status.fail_reason || 'unknown reason'}`);
  if (status.status !== 'PUBLISH_COMPLETE') return { status: 'processing', providerState: state };
  const postId = (status.publicaly_available_post_id || [])[0];
  return { status: 'published', externalId: String(postId || state.publishId), externalUrl: '', providerState: state };
}

// ---------- Google (YouTube) ----------

async function googleToken(env, params) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const data = await readProviderJson(response);
  if (!response.ok || !data.access_token) {
    throw new ProviderError(data.error_description || data.error || `Google sign-in failed (${response.status})`, { expired: true });
  }
  return data;
}

async function completeGoogle(env, code) {
  const token = await googleToken(env, { code, grant_type: 'authorization_code', redirect_uri: redirectUri(env, 'google') });
  const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const data = await readProviderJson(response);
  if (!response.ok) throw new ProviderError(data.error?.message || 'Could not read the YouTube channel.');
  const channels = data.items || [];
  if (!channels.length) throw new ProviderError('This Google account has no YouTube channel. Create a channel first, then reconnect.');
  return channels.map((channel) => ({
    platform: 'youtube', externalId: channel.id, displayName: channel.snippet?.title || 'YouTube channel',
    avatarUrl: channel.snippet?.thumbnails?.default?.url || '',
    profileUrl: channel.snippet?.customUrl ? `https://www.youtube.com/${channel.snippet.customUrl}` : `https://www.youtube.com/channel/${channel.id}`,
    accessToken: token.access_token, refreshToken: token.refresh_token || null, expiresAt: secondsFromNow(token.expires_in),
    scopes: token.scope || GOOGLE_SCOPES.join(' '), metadata: {},
  }));
}

async function publishYouTube({ account, post, media, openMedia }) {
  const video = media.find((item) => item.type === 'video');
  if (!video) throw new ProviderError('YouTube posts need a video.');
  const source = await openMedia(video);
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': source.contentType,
      'X-Upload-Content-Length': String(source.size),
    },
    body: JSON.stringify({
      snippet: { title: (post.title || post.content || 'Untitled video').slice(0, 100), description: post.content.slice(0, 5000), categoryId: '22' },
      status: { privacyStatus: post.options?.youtubePrivacy || 'public', selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) {
    const data = await readProviderJson(init);
    throw new ProviderError(data.error?.message || `YouTube upload could not start (${init.status})`, { expired: init.status === 401 });
  }
  const { readable, writable } = new FixedLengthStream(source.size);
  source.body.pipeTo(writable);
  const upload = await fetch(init.headers.get('Location'), {
    method: 'PUT', headers: { 'Content-Type': source.contentType }, body: readable,
  });
  const data = await readProviderJson(upload);
  if (!upload.ok || !data.id) throw new ProviderError(data.error?.message || `YouTube upload failed (${upload.status})`);
  return { status: 'published', externalId: data.id, externalUrl: `https://www.youtube.com/watch?v=${data.id}` };
}

// ---------- Shared entry points ----------

export async function completeOAuth(env, platform, code) {
  const { provider } = CONNECTABLE[platform];
  if (provider === 'meta') return completeMeta(env, platform, code);
  if (provider === 'tiktok') return completeTikTok(env, code);
  return completeGoogle(env, code);
}

// Returns fresh tokens when the stored access token is about to expire, otherwise null.
export async function refreshIfNeeded(env, account) {
  const expiresAt = account.expiresAt ? Date.parse(account.expiresAt) : null;
  if (!expiresAt || expiresAt - Date.now() > 5 * 60 * 1000) return null;
  if (!account.refreshToken) throw new ProviderError('The connection has expired. Reconnect the account.', { expired: true });
  if (account.platform === 'tiktok') {
    const token = await tiktokToken(env, { grant_type: 'refresh_token', refresh_token: account.refreshToken });
    return { accessToken: token.access_token, refreshToken: token.refresh_token || account.refreshToken, expiresAt: secondsFromNow(token.expires_in) };
  }
  if (account.platform === 'youtube') {
    const token = await googleToken(env, { grant_type: 'refresh_token', refresh_token: account.refreshToken });
    return { accessToken: token.access_token, refreshToken: token.refresh_token || account.refreshToken, expiresAt: secondsFromNow(token.expires_in) };
  }
  return null;
}

export function publishTarget(platform, context) {
  if (platform === 'facebook') return publishFacebook(context);
  if (platform === 'instagram') return publishInstagram(context);
  if (platform === 'tiktok') return publishTikTok(context);
  if (platform === 'youtube') return publishYouTube(context);
  throw new ProviderError(`Publishing to ${platform} is not supported yet.`);
}

// Platform rules checked before a post can be submitted, scheduled or published.
export function validateForPlatform(platform, post, media) {
  const images = media.filter((item) => item.type === 'image');
  const videos = media.filter((item) => item.type === 'video');
  const label = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' }[platform] || platform;
  if (platform === 'facebook') {
    if (!post.content && !media.length) return `${label}: add text or media.`;
    if (videos.length && images.length) return `${label}: use either one video or images, not both.`;
  }
  if (platform === 'instagram') {
    if (!media.length) return `${label}: add at least one image or video.`;
    if (media.length > 10) return `${label}: carousels allow at most 10 items.`;
    if (post.content.length > 2200) return `${label}: captions are limited to 2,200 characters.`;
    if (images.some((item) => item.mime ? item.mime !== 'image/jpeg' : !/\.jpe?g(\?|$)/i.test(item.url))) {
      return `${label}: images must be JPEG files.`;
    }
  }
  if (platform === 'tiktok') {
    if (!videos.length && !images.length) return `${label}: add a video or images.`;
    if (videos.length > 1) return `${label}: only one video per post.`;
    if (videos.length && images.length) return `${label}: use either a video or images, not both.`;
    if (post.content.length > 2200) return `${label}: captions are limited to 2,200 characters.`;
  }
  if (platform === 'youtube') {
    if (videos.length !== 1) return `${label}: add exactly one video.`;
    if (!(post.title || '').trim()) return `${label}: add a video title.`;
    if (post.title.length > 100) return `${label}: titles are limited to 100 characters.`;
  }
  return '';
}
