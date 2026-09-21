import path from 'node:path';
import fs from 'node:fs';
import { renderTemplate } from './templates/index.js';
import { getRenderBrowser } from '../lib/playwright.js';
import { getSettings } from '../lib/settings.js';
import { THUMB_DIR, ensureDirs } from '../lib/paths.js';
import { slugify } from '../lib/util.js';
import { logger } from '../lib/events.js';
import { maybeGenerateImage } from './imagegen.js';

/**
 * AI 가 설계한 문구/색상을 HTML 템플릿에 얹고 스크린샷으로 PNG를 만든다.
 * 이미지 생성 API를 쓰지 않으므로 추가 비용이 없다.
 */
/**
 * 파일 앞머리(매직 바이트)로 진짜 형식을 알아낸다.
 *
 * 서버가 알려주는 content-type 을 믿으면 안 된다. ChatGPT 가 만든 그림은
 * `image/webp` 로 오기도 하고, CDN 이 `application/octet-stream` 으로
 * 내려주는 경우도 있다. 그걸 그대로 확장자로 쓰면 엉뚱한 파일이 된다.
 */
export function sniffImage(buffer) {
  if (buffer.length < 12) return '';
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF'
      && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  return '';
}

/**
 * webp·gif 를 png 로 다시 뽑는다.
 *
 * 네이버 에디터는 webp 업로드를 거절하는 일이 있다. 거절당하면 업로드가
 * 끝나지 않아서 글 전체가 실패한다. 어차피 스크린샷용 브라우저가 있으니
 * 거기서 캔버스에 그려 png 로 바꿔 올린다. (새 의존성이 필요 없다)
 */
async function reencodeToPng(dataUri) {
  const browser = await getRenderBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const base64 = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }, dataUri);
    return Buffer.from(base64, 'base64');
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 받아온 그림을 파일로 떨군다.
 *
 * 예전에는 `data:image/([a-z]+);base64,` 만 받았다. 그래서 형식이 조금만
 * 달라도(예: `data:application/octet-stream;base64,`) 여기서 예외가 났고,
 * 그 예외가 renderThumbnail 을 통째로 무너뜨려 **HTML 썸네일 대체마저
 * 못 만들었다.** 글에 이미지가 하나도 안 들어간 원인이 이것이다.
 * 그래서 형식을 느슨하게 받고, 진짜 형식은 매직 바이트로 확인한다.
 */
async function saveDataUri(dataUri, jobId, title) {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]+)$/i.exec(String(dataUri).trim());
  if (!match) throw new Error('이미지 데이터를 읽지 못했습니다. (data URI 형식이 아닙니다)');

  let buffer = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'latin1');

  let kind = sniffImage(buffer);
  if (!kind) {
    throw new Error(
      `받은 데이터가 이미지가 아닙니다 (알려진 형식: ${match[1] || '없음'}, ${buffer.length}바이트).`,
    );
  }

  // 네이버가 확실히 받아주는 형식으로 맞춘다.
  if (kind !== 'png' && kind !== 'jpg') {
    logger.info(`${kind} 그림을 png 로 바꿔서 올립니다. (네이버가 거절하는 형식입니다)`, { jobId });
    buffer = await reencodeToPng(dataUri);
    if (sniffImage(buffer) !== 'png') throw new Error(`${kind} 그림을 png 로 바꾸지 못했습니다.`);
    kind = 'png';
  }

  const fileName = `${Date.now()}-${jobId || slugify(title, 24)}.${kind}`;
  const filePath = path.join(THUMB_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  return { filePath, fileName };
}

export async function renderThumbnail(post, { jobId = '', signal } = {}) {
  ensureDirs();
  const settings = getSettings();
  const { width, height } = settings.thumbnail;

  // 이미지 API 에 맡기는 부분.
  //   full    — 글자까지 그린 완성 썸네일이 온다. 그대로 쓴다.
  //   overlay — 글자 없는 배경만 온다. 아래에서 브라우저가 한글을 얹는다.
  // 꺼져 있거나 실패하면 null 이 오고, HTML 썸네일로 그대로 진행한다.
  const generated = await maybeGenerateImage(post.thumbnail, {
    signal, width, height, jobId,
  });

  /*
   * 완성본(글자까지 그려진 그림)이 왔으면 브라우저를 띄울 이유가 없다.
   * 받은 그림을 그대로 저장한다.
   *
   * **여기서 실패해도 던지지 않는다.** 예전에는 저장이 어긋나면 그 예외가
   * renderThumbnail 을 통째로 무너뜨려서, HTML 썸네일 대체마저 못 만들고
   * 글에 이미지가 하나도 안 들어갔다. 그림 한 장 저장에 실패한 것과
   * "썸네일이 아예 없는 것" 은 전혀 다른 일이다.
   */
  let generatedFull = null;
  if (generated?.mode === 'full') {
    try {
      generatedFull = await saveDataUri(generated.dataUri, jobId, post.title);
    } catch (error) {
      logger.warn(
        `만든 그림을 저장하지 못해 HTML 썸네일로 만듭니다: ${error.message}`,
        { jobId },
      );
    }
  }

  if (generatedFull) {
    const size = fs.statSync(generatedFull.filePath).size;
    logger.info(`썸네일 저장 완료 (ChatGPT 완성본, ${Math.round(size / 1024)}KB)`, { jobId });
    return { ...generatedFull, style: 'api', generated: true, mode: 'full' };
  }

  // full 모드였는데 저장이 안 됐으면 배경으로도 쓰지 않는다. 그 그림이 문제였을 수 있다.
  const background = generated?.mode === 'full' ? null : generated;
  const spec = {
    ...post.thumbnail,
    // 정보성 글은 기호를 자제하는 편이 안전하다. 설정에서 켤 때만 넣는다.
    emoji: settings.thumbnail.emoji ? post.thumbnail.emoji : '',
    background: background?.dataUri || '',
    width,
    height,
  };
  const html = renderTemplate(spec);

  const browser = await getRenderBrowser();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,          // 네이버에 올려도 흐려지지 않게 2배로 뽑는다.
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // 웹폰트를 기다리되, 네트워크가 막혀 있으면 로컬 폰트로 그냥 진행한다.
    await page
      .evaluate(() => Promise.race([
        document.fonts?.ready,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]))
      .catch(() => {});
    await page.waitForTimeout(250);

    const fileName = `${Date.now()}-${jobId || slugify(post.title, 24)}.png`;
    const filePath = path.join(THUMB_DIR, fileName);
    await page.screenshot({ path: filePath, type: 'png' });

    const size = fs.statSync(filePath).size;
    const layout = spec.background ? '배경 그림 + 문구' : spec.style;
    logger.info(`썸네일 생성 완료 (${layout}, ${Math.round(size / 1024)}KB)`, { jobId });
    return {
      filePath, fileName, style: spec.style,
      generated: Boolean(spec.background), mode: 'overlay',
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 표를 그림으로 그린다. 표 붙여넣기가 끝내 실패했을 때의 마지막 수단이다.
 *
 * 워드프레스판에는 없던 기능이다. 거기서는 표를 API 로 보내니 실패할 일이 없다.
 * 네이버는 에디터가 큰 표를 흘려버리는 일이 있어서, 그럴 때 그림으로라도
 * 넣어야 100행짜리 순위표가 통째로 사라지지 않는다.
 * 파일로 올리기 때문에 클립보드를 안 거치고, 그래서 거절당하지 않는다.
 */
export async function renderTableImages(chunksHtml, { jobId = '' } = {}) {
  ensureDirs();
  const images = [];

  for (let index = 0; index < chunksHtml.length; index += 1) {
    const html = `<body style="margin:0; padding:24px; background:#fff;">${chunksHtml[index]}</body>`;
    const fileName = `${Date.now()}-${jobId || 'table'}-t${index + 1}.png`;
    const filePath = path.join(THUMB_DIR, fileName);

    const browser = await getRenderBrowser();
    const context = await browser.newContext({
      viewport: { width: 900, height: 800 },
      deviceScaleFactor: 2,
      locale: 'ko-KR',
    });
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await page.waitForTimeout(250);
      // 표 높이가 얼마든 잘리지 않게 페이지 전체를 찍는다.
      await page.screenshot({ path: filePath, type: 'png', fullPage: true });
      images.push({ filePath, fileName });
    } finally {
      await context.close().catch(() => {});
    }
  }

  logger.info(`표를 그림 ${images.length}장으로 만들었습니다.`, { jobId });
  return images;
}

/** 대시보드 미리보기용 — 저장하지 않고 HTML만 돌려준다. */
export function previewThumbnailHtml(spec) {
  const settings = getSettings();
  return renderTemplate({
    headline: spec.headline || '썸네일 미리보기',
    subline: spec.subline || '주제에 맞춰 AI가 문구를 만듭니다',
    badge: spec.badge || '정보 정리',
    emoji: settings.thumbnail.emoji ? (spec.emoji || '') : '',
    accent: /^#[0-9a-f]{6}$/i.test(spec.accent || '') ? spec.accent : '#16324F',
    style: spec.style && spec.style !== 'auto' ? spec.style : 'minimal',
    width: settings.thumbnail.width,
    height: settings.thumbnail.height,
  });
}
