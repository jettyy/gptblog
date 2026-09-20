import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { readChatGptSession } from '../ai/session.js';
import { generateImageWeb } from '../ai/webchat.js';
import { runChatGpt, extractJson } from '../ai/chatgpt.js';

/**
 * 썸네일 이미지 생성.
 *
 * **API 키를 쓰지 않는다.** 이미 내고 있는 ChatGPT 구독 계정으로 만든다.
 * 구독으로 그림을 받는 통로는 chatgpt.com 대화창뿐이라, 네이버 글쓰기와 똑같이
 * 진짜 브라우저를 몰아서 그림을 받아온다. (src/ai/webchat.js)
 *
 * 그래서 예전 구글 API 판에 있던 것들이 여기서 사라졌다.
 *   - 가격표와 "가장 싼 모델부터" 정렬  → 구독이라 장당 요금이 없다
 *   - 모델 목록 받아오기와 캐시          → 고를 모델이 하나다
 *   - API 키 관리                       → 로그인 세션이 대신한다
 *
 * 두 가지 방식은 그대로다.
 *   full    — 제목·띠·뱃지까지 그림 안에 통째로 그린다. 포스터형 썸네일이 나온다.
 *   overlay — 글자 없는 배경만 그리고 한글은 HTML 이 얹는다. 한글이 절대 안 깨진다.
 *
 * full 방식은 이미지 모델이 한글을 뭉갤 수 있다. 그래서 만들고 나서
 * 글자를 다시 읽어 확인하고, 깨졌으면 다시 그리거나 HTML 썸네일로 물러선다.
 */

/** 흔히 쓰는 비율. 대화창에는 비율 옵션이 없어서 말로 일러준다. */
const ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);

/* ------------------------------------------------------------------ */
/* 프롬프트                                                            */
/* ------------------------------------------------------------------ */

/** 썸네일 비율(1200x630 등)에 가장 가까운 허용 비율을 고른다. */
export function pickAspectRatio(width, height) {
  const wanted = Number(width) / Number(height);
  if (!Number.isFinite(wanted) || wanted <= 0) return '16:9';
  let best = '16:9';
  let bestGap = Infinity;
  for (const ratio of ASPECT_RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    const gap = Math.abs((w / h) - wanted);
    if (gap < bestGap) { bestGap = gap; best = ratio; }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* full 모드 — 글자까지 통째로 그리는 포스터형 썸네일                     */
/* ------------------------------------------------------------------ */

const POSTER_LOOK = {
  bold: 'bold Korean clickbait-style blog thumbnail poster, vivid saturated colors, '
    + 'strong navy and orange and yellow accents, thick white outlines and drop shadows on the text, '
    + 'energetic and eye-catching, high contrast',
  clean: 'clean modern Korean blog thumbnail poster, calm navy and white palette with one accent color, '
    + 'generous spacing, restrained and trustworthy, editorial feel',
  playful: 'friendly Korean blog thumbnail poster, rounded soft shapes, cheerful pastel palette '
    + 'with warm accents, approachable cartoon illustration style',
};

/**
 * 프롬프트에 넣을 한 줄.
 * 따옴표가 섞이면 지시가 끊기고, 줄바꿈이 들어가면 문단이 갈라진다.
 * 둘 다 공백으로 바꾸고 남은 공백을 하나로 줄인다.
 */
const quote = (value) => `"${String(value || '').replace(/["\n]/g, ' ').replace(/\s+/g, ' ').trim()}"`;

/**
 * 글자까지 포함한 완성 썸네일 프롬프트.
 *
 * 핵심은 **어떤 글자가 어디에 들어가는지 한 글자씩 못박는 것**이다.
 * "제목을 넣어줘" 라고 하면 모델이 알아서 문구를 지어내고, 그 과정에서
 * 한글이 뭉개진다. 넣을 글자를 정확히 적어주고 "이 글자 말고는 아무것도
 * 쓰지 마라" 고 해야 그나마 정확히 나온다.
 */
export function buildPosterPrompt(spec, poster) {
  const lines = (Array.isArray(spec.posterLines) && spec.posterLines.length
    ? spec.posterLines
    : [spec.headline]).filter(Boolean).slice(0, 3);

  const look = POSTER_LOOK[poster] || POSTER_LOOK.bold;
  const scene = String(spec.scene || '').trim()
    || 'a bright Korean workplace scene related to the topic';
  const keywords = (Array.isArray(spec.keywords) ? spec.keywords : []).filter(Boolean).slice(0, 5);

  const parts = [
    look,
    `wide banner composition. Background illustration: ${scene}`,

    // 여기부터가 글자 지시. 넣을 문구를 한 줄씩 정확히 적는다.
    'The poster must contain EXACTLY the following Korean text and NOTHING else:',
    `Main headline, stacked on ${lines.length} line(s), the largest text on the poster, `
      + `each line rendered exactly as written: ${lines.map(quote).join(' then ')}`,
  ];

  if (spec.ribbon) {
    parts.push(`A ribbon or banner strip across the lower middle reading exactly ${quote(spec.ribbon)}`);
  }
  if (spec.subline) {
    parts.push(`A smaller supporting line under the headline reading exactly ${quote(spec.subline)}`);
  }
  if (spec.badge) {
    parts.push(`A small rounded badge in a corner reading exactly ${quote(spec.badge)}`);
  }
  if (keywords.length) {
    parts.push(
      'A vertical column of small circular icon badges along one side, each with a simple flat icon '
      + `and a short Korean label under it, the labels being exactly: ${keywords.map(quote).join(', ')}`,
    );
  }

  parts.push(
    // 한글이 깨지는 것을 막는 지시. 여러 번 다르게 반복해야 그나마 듣는다.
    'CRITICAL: every Korean character must be rendered perfectly and legibly, '
    + 'correct Hangul syllable shapes, no broken, garbled, invented, duplicated or misspelled characters',
    'Use a heavy rounded Korean sans-serif typeface (like Noto Sans KR Black) for the headline',
    'Do NOT add any other text, no English words, no lorem ipsum, no watermark, no logo, no signature, '
    + 'no website address, no page numbers, no extra captions beyond the lines listed above',
    'Do not show any real person\'s face, no brand logos, no copyrighted characters',
    'Text must sit on solid or shaded panels so it stays readable against the illustration',
  );

  return parts.join('. ');
}

/**
 * 그림 프롬프트 (overlay 모드).
 *
 * "글자를 넣지 마라" 를 여러 표현으로 반복한다. 한 번만 말하면 모델이
 * 간판이나 표지판 형태로 글자를 그려 넣는 일이 잦다.
 */
export function buildImagePrompt(spec, style) {
  const scene = String(spec.scene || '').trim()
    || `a clean conceptual illustration about ${spec.headline || 'an informative article'}`;

  const looks = {
    flat: 'flat vector illustration, simple geometric shapes, soft muted palette, generous negative space',
    soft: 'soft gradient illustration, gentle rounded shapes, calm pastel palette, lots of empty space',
    photo: 'clean minimal photograph, shallow depth of field, soft natural light, uncluttered composition',
    line: 'minimal line art illustration, thin confident strokes, two tone palette, airy composition',
  }[style] || 'flat vector illustration, soft muted palette, generous negative space';

  return [
    scene,
    looks,
    // 글자를 얹을 자리를 비워두게 한다. 안 그러면 가운데가 꽉 차서 문구가 안 보인다.
    'composition keeps the left half and the center visually calm and uncluttered so text can be placed there',
    'no text, no letters, no words, no numbers, no typography, no captions, no labels',
    'no signage, no billboards, no book titles, no watermark, no logo, no signature, no UI elements',
    'blog header background image, wide banner',
  ].join('. ');
}

/* ------------------------------------------------------------------ */
/* 글자 검사                                                            */
/* ------------------------------------------------------------------ */

/** 만든 그림을 임시 파일로 떨어뜨린다. codex 에 이미지를 보여주려면 파일이 필요하다. */
function writeTempImage(dataUri) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(String(dataUri));
  if (!match) return '';
  const extension = (match[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const file = path.join(os.tmpdir(), `inforush-thumb-${Date.now()}.${extension}`);
  try {
    fs.writeFileSync(file, Buffer.from(match[2], 'base64'));
    return file;
  } catch {
    return '';
  }
}

/**
 * 그림 안의 한글이 제대로 나왔는지 이미지를 다시 읽어 확인한다.
 *
 * 글자를 이미지에 직접 그리게 하면 한글이 뭉개지는 일이 있다.
 * 100편을 돌린 뒤에 알면 늦으므로 만들자마자 확인한다.
 *
 * 확인은 **codex CLI 에 그림을 보여주는 방식**으로 한다. 같은 구독 계정을 쓰면서
 * 글자 몇 개만 돌려받는 호출이라 빠르고, 대화창을 한 번 더 몰지 않아도 된다.
 * (codex 가 없으면 조용히 건너뛴다. 확인을 못 한 것과 글자가 깨진 것은 다른 일이다)
 *
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function verifyKoreanText(dataUri, expectedLines, { signal } = {}) {
  const file = writeTempImage(dataUri);
  if (!file) return { ok: true, reason: '이미지를 읽지 못해 건너뜀' };

  const wanted = expectedLines.filter(Boolean).map((line) => `"${line}"`).join(', ');
  const prompt = [
    '첨부한 이미지에 있는 한글 글자를 그대로 읽어 주세요.',
    `이 문구들이 오타 없이 정확히 들어 있어야 합니다: ${wanted}`,
    '글자가 뭉개졌거나, 없는 글자가 섞였거나, 문구가 틀렸으면 실패입니다.',
    '아래 JSON 만 출력하세요.',
    '{"readable": true, "matches": true, "found": "이미지에서 읽은 글자", "problem": "문제가 있으면 한 줄"}',
  ].join('\n');

  try {
    const reply = await runChatGpt(prompt, {
      systemPrompt: '이미지에서 글자를 읽어 JSON 으로만 답합니다.',
      images: [file],
      timeoutMs: 120000,
      signal,
    });
    const verdict = extractJson(reply.text);

    if (verdict.readable === false || verdict.matches === false) {
      return {
        ok: false,
        reason: verdict.problem || `읽힌 글자: ${String(verdict.found || '').slice(0, 80)}`,
      };
    }
    return { ok: true, reason: '' };
  } catch (error) {
    // 확인 자체가 실패한 것을 "글자가 깨졌다"로 보면 멀쩡한 그림을 버리게 된다.
    return { ok: true, reason: `확인하지 못해 넘어갑니다 (${String(error.message).split('\n')[0]})` };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 만들기                                                              */
/* ------------------------------------------------------------------ */

/**
 * 배경 그림(또는 포스터) 한 장을 만든다.
 *
 * @returns {Promise<{dataUri, model, bytes, tier, usd}>}
 * @throws  실패하면 사람이 읽을 수 있는 이유를 담아 던진다. 부르는 쪽에서 잡아 넘긴다.
 */
export async function generateBackground(spec, { signal, aspectRatio, mode } = {}) {
  const { image } = getSettings();
  if (!readChatGptSession().loggedIn) {
    const error = new Error(
      'ChatGPT 에 로그인되어 있지 않아 그림을 만들 수 없습니다. '
      + '대시보드 1번 칸의 [ChatGPT 로그인 창 열기] 를 눌러 구독 계정으로 로그인해 주세요.',
    );
    error.authExpired = true;
    throw error;
  }

  const ratio = ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '16:9';
  const useFull = (mode || image.mode) === 'full';
  const prompt = useFull
    ? buildPosterPrompt(spec, image.poster)
    : buildImagePrompt(spec, image.style);

  const result = await generateImageWeb(prompt, {
    signal,
    aspectRatio: ratio,
    timeoutMs: image.timeoutMs,
  });

  return {
    ...result,
    tier: 'ChatGPT 구독',
    // 구독에 포함되어 있어 장당 요금이 붙지 않는다. 화면에 값을 안 띄우게 null 을 준다.
    usd: null,
  };
}

/** full 모드에서 그림 안에 정확히 들어가야 하는 문구들. */
function expectedLines(spec) {
  const lines = Array.isArray(spec.posterLines) && spec.posterLines.length
    ? spec.posterLines
    : [spec.headline];
  return [...lines, spec.ribbon].filter(Boolean);
}

/**
 * 썸네일 이미지를 만든다. 실패해도 글을 막지 않는다.
 * 꺼져 있거나 로그인이 안 되어 있으면 조용히 null 을 준다.
 *
 * full 모드는 글자까지 그리게 하고, 글자가 깨졌으면 설정한 횟수만큼 다시 그린다.
 * 그래도 깨지면 null 을 돌려 HTML 썸네일로 물러선다. (한글이 절대 안 깨진다)
 *
 * @returns {Promise<{dataUri, model, bytes, mode}|null>}
 */
export async function maybeGenerateImage(spec, { signal, width, height, jobId = '' } = {}) {
  const { image } = getSettings();
  if (!image.enabled) return null;
  if (!readChatGptSession().loggedIn) {
    logger.warn(
      '이미지 생성이 켜져 있지만 ChatGPT 로그인이 안 되어 있습니다. HTML 썸네일로 만듭니다.',
      { jobId },
    );
    return null;
  }

  const full = image.mode === 'full';
  const aspectRatio = pickAspectRatio(width, height);
  const what = full ? '썸네일' : '썸네일 배경 그림';
  const checking = full && image.verifyText;

  // 글자를 확인하는 경우에만 다시 그린다. 확인을 안 하면 한 장으로 끝낸다.
  const tries = checking ? Math.max(1, Number(image.retries) || 0) + 1 : 1;
  let lastReason = '';

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    let result;
    try {
      result = await generateBackground(spec, { signal, aspectRatio });
    } catch (error) {
      // 중지는 사람이 누른 것이다. 삼키면 [중지] 를 눌러도 계속 돈다.
      if (/중지했습니다/.test(error.message)) throw error;
      // 그림은 글의 부속물이다. 여기서 실패했다고 1,800자짜리 글을 버리지 않는다.
      logger.warn(`${what} 생성 실패, HTML 썸네일로 만듭니다: ${error.message}`, { jobId });
      return null;
    }

    const made = `${result.model}${result.tier ? ` · ${result.tier}` : ''}, `
      + `${Math.round(result.bytes / 1024)}KB`;

    if (!checking) {
      logger.info(`${what}을(를) 만들었습니다. (${made})`, { jobId });
      return { ...result, mode: image.mode };
    }

    const verdict = await verifyKoreanText(result.dataUri, expectedLines(spec), { signal });
    if (verdict.ok) {
      logger.info(
        `${what}을(를) 만들었습니다. (${made}`
        + `${verdict.reason ? ` · ${verdict.reason}` : ' · 글자 확인 통과'}`
        + `${attempt > 1 ? ` · ${attempt}번째 시도` : ''})`,
        { jobId },
      );
      return { ...result, mode: image.mode };
    }

    lastReason = verdict.reason;
    logger.warn(
      `썸네일의 한글이 제대로 안 나왔습니다 (${attempt}/${tries}): ${verdict.reason}`
      + (attempt < tries ? ' — 다시 그려 봅니다.' : ''),
      { jobId },
    );
  }

  logger.warn(
    `한글이 계속 깨져 HTML 썸네일로 만듭니다. 마지막 문제: ${lastReason}`
    + ' (설정에서 "배경만 그리기" 로 바꾸면 한글이 깨질 일이 없습니다)',
    { jobId },
  );
  return null;
}

/** 예전 이름. 부르는 곳이 남아 있을 수 있어 남겨 둔다. */
export const maybeGenerateBackground = maybeGenerateImage;
