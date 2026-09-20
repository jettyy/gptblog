import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import {
  getChatGptContext, readChatGptSession, hasChatGptCookies, looksLoggedOut, CHATGPT_ORIGIN,
} from './session.js';

/**
 * chatgpt.com 을 실제 브라우저로 몰아 쓰는 모듈.
 *
 * **그림은 이 길밖에 없다.** ChatGPT 구독으로 그림을 받는 통로는 대화창뿐이라,
 * API 키를 쓰지 않으려면 화면을 그대로 몰아야 한다. 글쓰기도 설정에서 "웹" 을
 * 고르면 여기로 온다. (기본은 codex CLI 쪽이 안정적이라 그쪽을 쓴다)
 *
 * 화면 구조는 예고 없이 바뀐다. 그래서 네이버 쪽(src/naver/selectors.js)과
 * 같은 방식으로 **후보 선택자를 여러 개** 두고 먼저 잡히는 것을 쓴다.
 * 자동화가 깨지면 대부분 아래 SELECTORS 만 손보면 된다.
 */

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

const SELECTORS = {
  // 프롬프트를 넣는 칸 (ProseMirror contenteditable)
  composer: [
    '#prompt-textarea',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    'form div[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea[data-id]',
    'textarea',
  ],

  // 보내기 버튼. Enter 가 막힌 판을 위한 예비 경로다.
  send: [
    'button[data-testid="send-button"]',
    'button[aria-label="프롬프트 보내기"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="보내기"]',
    'button[aria-label*="Send"]',
  ],

  // 답을 쓰고 있는 동안에만 있는 버튼. 이게 사라지면 답이 끝난 것이다.
  stop: [
    'button[data-testid="stop-button"]',
    'button[aria-label="스트리밍 중지"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label*="중지"]',
    'button[aria-label*="Stop"]',
  ],

  // 답 말풍선
  assistant: [
    '[data-message-author-role="assistant"]',
    'div[data-testid^="conversation-turn"] .markdown',
    '.agent-turn',
  ],

  // 처음 들어갔을 때 뜨는 안내 팝업들
  dismiss: [
    'button[data-testid="close-button"]',
    'button:text-is("확인")',
    'button:text-is("Okay, let\'s go")',
    'button:text-is("시작하기")',
    'div[role="dialog"] button[aria-label*="닫기"]',
    'div[role="dialog"] button[aria-label*="Close"]',
  ],
};

/** 후보들 중 실제로 보이는 첫 요소를 찾는다. (네이버 쪽 findFirst 와 같은 생각) */
async function findFirst(scope, candidates, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const selector of candidates) {
      try {
        const locator = scope.locator(selector).first();
        if (await locator.isVisible({ timeout: 300 })) return { locator, selector };
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `ChatGPT 화면에서 요소를 찾지 못했습니다: ${candidates[0]} 외 ${candidates.length - 1}개 후보`
    + (lastError ? ` (${String(lastError.message).split('\n')[0]})` : ''),
  );
}

async function clickIfPresent(scope, candidates, timeout = 1500) {
  try {
    const { locator } = await findFirst(scope, candidates, timeout);
    await locator.click({ timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 대화창은 한 번에 하나만 쓴다.
 *
 * 글쓰기와 그림 생성이 같은 브라우저 탭 하나를 나눠 쓰기 때문에, 둘이 겹치면
 * 서로의 프롬프트를 덮어써서 엉뚱한 답이 붙는다. 순서대로 줄을 세운다.
 */
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task, task);
  // 앞의 작업이 실패해도 줄이 끊기지 않게 한다.
  queue = run.then(() => {}, () => {});
  return run;
}

/** 로그인이 풀린 오류를 만들어 던진다. 부르는 쪽이 실행을 세울 수 있게 표시를 붙인다. */
function authError(message) {
  const error = new Error(message);
  error.authExpired = true;
  return error;
}

/** 새 대화를 띄운다. */
async function openChat({ model, signal } = {}) {
  const settings = getSettings();
  if (!readChatGptSession().loggedIn) {
    throw authError(
      'ChatGPT 에 로그인되어 있지 않습니다. 대시보드 1번 칸의 '
      + '[ChatGPT 로그인 창 열기] 를 눌러 구독 계정으로 로그인해 주세요.',
    );
  }

  const ctx = await getChatGptContext();
  const page = await ctx.newPage();

  const params = new URLSearchParams();
  const wanted = model || settings.chatgpt.webModel || '';
  if (wanted) params.set('model', wanted);
  // 100편을 돌리면 대화 목록이 100개 쌓인다. 임시 채팅이면 기록이 남지 않는다.
  if (settings.chatgpt.temporaryChat) params.set('temporary-chat', 'true');
  const url = `${CHATGPT_ORIGIN}/${params.toString() ? `?${params}` : ''}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (signal?.aborted) throw new Error('사용자가 중지했습니다.');

    if (!(await hasChatGptCookies(ctx).catch(() => false)) || await looksLoggedOut(page)) {
      throw authError(
        'ChatGPT 로그인이 풀렸습니다. 대시보드 1번 칸의 [ChatGPT 로그인 창 열기] 를 '
        + '눌러 다시 로그인해 주세요.',
      );
    }

    await clickIfPresent(page, SELECTORS.dismiss, 1200);
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

/**
 * 프롬프트를 칸에 넣는다.
 *
 * 한 글자씩 치면 5,000자짜리 프롬프트에 몇 분이 걸린다. 그래서
 *   1) 실제 클립보드 + Ctrl+V  — 줄바꿈이 문단으로 그대로 들어간다
 *   2) fill()                 — 클립보드 권한이 막힌 환경의 예비 경로
 * 순서로 시도한다.
 */
async function typePrompt(page, composer, text) {
  try {
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await composer.click();
    await page.keyboard.press(`${MODIFIER}+A`);
    await page.keyboard.press(`${MODIFIER}+V`);
    await page.waitForTimeout(400);
    const landed = String(await composer.innerText().catch(() => '')).replace(/\s+/g, '');
    // 앞 80자만 맞춰본다. 끝까지 비교하면 에디터가 넣은 문단 구분 때문에 늘 어긋난다.
    if (landed.includes(text.replace(/\s+/g, '').slice(0, 80))) return 'clipboard';
  } catch {
    // 클립보드가 막힌 환경이다. 아래로 내려간다.
  }

  await composer.fill(text);
  await page.waitForTimeout(300);
  const landed = String(await composer.innerText().catch(() => '')).replace(/\s+/g, '');
  if (!landed.includes(text.replace(/\s+/g, '').slice(0, 40))) {
    throw new Error('프롬프트를 ChatGPT 입력칸에 넣지 못했습니다. 화면 구조가 바뀐 것 같습니다.');
  }
  return 'fill';
}

/** 답이 끝날 때까지 기다린다. */
async function waitForAnswer(page, { timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;

  // 먼저 "쓰는 중" 표시가 나타나는지 본다. 안 나타나도 그냥 넘어간다.
  // (짧은 답은 표시가 뜨기 전에 끝나 버린다)
  let streaming = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('사용자가 중지했습니다.');
    for (const selector of SELECTORS.stop) {
      if (await page.locator(selector).first().isVisible({ timeout: 200 }).catch(() => false)) {
        streaming = true;
        break;
      }
    }
    if (streaming) break;
    // 30초가 지나도 표시가 없으면 이미 끝났거나 안 보내진 것이다.
    if (Date.now() > deadline - timeoutMs + 30000) break;
    await page.waitForTimeout(500);
  }

  // 그다음 표시가 사라질 때까지 기다린다. 이게 "다 썼다" 는 신호다.
  let quiet = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('사용자가 중지했습니다.');
    let visible = false;
    for (const selector of SELECTORS.stop) {
      if (await page.locator(selector).first().isVisible({ timeout: 200 }).catch(() => false)) {
        visible = true;
        break;
      }
    }
    if (!visible) {
      quiet += 1;
      // 문단 사이에서 표시가 잠깐 꺼지는 일이 있다. 연달아 조용할 때만 끝으로 본다.
      if (quiet >= 4) return;
    } else {
      quiet = 0;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`ChatGPT 응답이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`);
}

/** 마지막 답 말풍선에서 글을 뽑는다. 코드블록이 있으면 그 안만 쓴다. */
async function readAnswer(page) {
  for (const selector of SELECTORS.assistant) {
    const found = await page.evaluate((sel) => {
      const turns = [...document.querySelectorAll(sel)];
      const last = turns[turns.length - 1];
      if (!last) return null;

      // JSON 을 코드블록으로 감싸 주는 경우가 많다. 그 안만 쓰면
      // "복사" 같은 버튼 글자가 섞이지 않는다.
      const blocks = [...last.querySelectorAll('pre code, pre')]
        .map((node) => node.textContent || '')
        .filter((value) => value.trim());
      if (blocks.length) {
        return blocks.reduce((longest, value) => (value.length > longest.length ? value : longest), '');
      }
      return last.innerText || last.textContent || '';
    }, selector).catch(() => null);

    if (found && String(found).trim()) return String(found).trim();
  }
  return '';
}

/**
 * chatgpt.com 대화창에 물어보고 답을 글로 받는다.
 * @returns {Promise<{text: string, model: string, durationMs: number, searches: number}>}
 */
export function askChatGptWeb(prompt, { signal, timeoutMs, model } = {}) {
  return exclusive(async () => {
    const settings = getSettings();
    const limit = timeoutMs || settings.chatgpt.webTimeoutMs || 300000;
    const started = Date.now();
    const page = await openChat({ model, signal });

    try {
      const { locator: composer } = await findFirst(page, SELECTORS.composer, 30000);
      await typePrompt(page, composer, prompt);

      // Enter 가 줄바꿈으로 먹는 판이 있어 보내기 버튼을 먼저 본다.
      if (!(await clickIfPresent(page, SELECTORS.send, 2000))) {
        await page.keyboard.press('Enter');
      }

      await waitForAnswer(page, { timeoutMs: limit, signal });
      const text = await readAnswer(page);
      if (!text) {
        throw new Error('ChatGPT 답을 화면에서 읽지 못했습니다. 화면 구조가 바뀐 것 같습니다.');
      }
      return { text, model: model || settings.chatgpt.webModel || '', durationMs: Date.now() - started, searches: 0 };
    } finally {
      await page.close().catch(() => {});
    }
  });
}

/* ------------------------------------------------------------------ */
/* 그림 받아오기                                                        */
/* ------------------------------------------------------------------ */

/** 답 말풍선 안에 새로 생긴 그림의 주소를 찾는다. */
async function findImageSrc(page) {
  return page.evaluate(() => {
    const turns = [...document.querySelectorAll('[data-message-author-role="assistant"], .agent-turn')];
    const last = turns[turns.length - 1] || document.body;
    const images = [...last.querySelectorAll('img')]
      .map((node) => node.getAttribute('src') || node.currentSrc || '')
      // 프로필 사진과 아이콘을 걸러낸다. 만든 그림은 크다.
      .filter((src) => src && !/^data:image\/svg/i.test(src))
      .filter((src) => /^(https?:|blob:)/i.test(src));
    return images[images.length - 1] || '';
  }).catch(() => '');
}

/** 답이 그림 대신 "못 만들겠다" 는 글만 왔는지. */
function refusalFrom(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (/(만들 수 없|생성할 수 없|도와드릴 수 없|정책|policy|can'?t (?:create|generate)|unable to (?:create|generate))/i
    .test(value)) {
    return value.slice(0, 200);
  }
  return '';
}

/** 주소에서 그림 바이트를 받아온다. blob: 은 페이지 안에서만 읽힌다. */
async function fetchImage(page, src) {
  if (/^blob:/i.test(src)) {
    const encoded = await page.evaluate(async (url) => {
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]);
      }
      return { data: btoa(binary), mimeType: response.headers.get('content-type') || 'image/png' };
    }, src);
    return { data: encoded.data, mimeType: encoded.mimeType.split(';')[0] };
  }

  // 로그인 쿠키가 필요한 주소일 수 있어 브라우저 컨텍스트로 받는다.
  const response = await page.context().request.get(src, { timeout: 120000 });
  if (!response.ok()) {
    throw new Error(`만든 그림을 내려받지 못했습니다 (${response.status()}).`);
  }
  const buffer = await response.body();
  const mimeType = String(response.headers()['content-type'] || 'image/png').split(';')[0];
  return { data: buffer.toString('base64'), mimeType };
}

/**
 * ChatGPT 구독 계정으로 그림 한 장을 만든다.
 *
 * 대화창에 "이런 그림을 그려줘" 라고 넣고, 답에 붙은 그림을 받아온다.
 * 값은 구독에 포함되어 있어 장당 요금이 붙지 않는다. 대신 구독 등급마다
 * 하루에 만들 수 있는 장수가 정해져 있어서, 한도에 걸리면 그 사실이
 * 답으로 돌아온다.
 *
 * @returns {Promise<{dataUri: string, bytes: number, model: string}>}
 */
export function generateImageWeb(prompt, { signal, timeoutMs, aspectRatio } = {}) {
  return exclusive(async () => {
    const settings = getSettings();
    const limit = timeoutMs || settings.image.timeoutMs || 300000;
    const page = await openChat({ signal });

    // 비율은 말로 일러준다. 대화창에는 비율 옵션이 따로 없다.
    const ratio = aspectRatio || '16:9';
    const ask = [
      `아래 설명대로 그림 한 장을 만들어 주세요. 가로세로 비율은 ${ratio} 입니다.`,
      '설명이나 인사말 없이 그림만 만들어 주세요. 여러 장 만들지 말고 한 장만 만드세요.',
      '',
      prompt,
    ].join('\n');

    try {
      const { locator: composer } = await findFirst(page, SELECTORS.composer, 30000);
      await typePrompt(page, composer, ask);
      if (!(await clickIfPresent(page, SELECTORS.send, 2000))) {
        await page.keyboard.press('Enter');
      }

      await waitForAnswer(page, { timeoutMs: limit, signal });

      // 그림은 답이 끝난 뒤에도 몇 초 더 붙는 일이 있다.
      let src = '';
      const deadline = Date.now() + 60000;
      while (!src && Date.now() < deadline) {
        if (signal?.aborted) throw new Error('사용자가 중지했습니다.');
        src = await findImageSrc(page);
        if (src) break;
        await page.waitForTimeout(1500);
      }

      if (!src) {
        const answer = await readAnswer(page);
        const refusal = refusalFrom(answer);
        throw new Error(refusal
          ? `ChatGPT 가 그림을 만들지 않았습니다: ${refusal}`
          : '답에 그림이 없습니다. 구독 등급의 그림 생성 한도에 걸렸을 수 있습니다.');
      }

      const { data, mimeType } = await fetchImage(page, src);
      return {
        dataUri: `data:${mimeType};base64,${data}`,
        bytes: Math.round((data.length * 3) / 4),
        model: settings.chatgpt.webModel || 'chatgpt (구독)',
      };
    } finally {
      await page.close().catch(() => {});
    }
  });
}

/** 대시보드에서 "지금 웹 대화가 되는지" 한 번 확인하는 데 쓴다. */
export async function checkChatGptWeb() {
  try {
    const reply = await askChatGptWeb('"준비완료" 라고만 답하세요. 다른 말은 하지 마세요.', {
      timeoutMs: 120000,
    });
    return { ok: true, answer: reply.text.slice(0, 100), message: '' };
  } catch (error) {
    logger.warn(`ChatGPT 웹 확인 실패: ${error.message}`);
    return { ok: false, answer: '', message: error.message };
  }
}
