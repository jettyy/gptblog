import fs from 'node:fs';
import { chromium } from 'playwright';
import { ensureBrowsers, withExecutable } from '../lib/playwright.js';
import {
  CHATGPT_PROFILE_DIR, CHATGPT_SESSION_FILE, CHATGPT_STORAGE_FILE, ensureDirs,
} from '../lib/paths.js';
import { getSettings } from '../lib/settings.js';
import { logger, push } from '../lib/events.js';

/**
 * ChatGPT 구독 계정 세션.
 *
 * 그림은 API 키로 만들지 않는다. **이미 내고 있는 ChatGPT 구독으로** 만든다.
 * 구독 계정으로 그림을 받는 길은 chatgpt.com 화면뿐이라, 네이버와 똑같은 방식으로
 * 진짜 브라우저 창을 띄워 사람이 직접 로그인하게 하고 세션만 넘겨받는다.
 *
 * 프로필은 **네이버와 따로** 둔다. 한 프로필에 둘을 같이 담으면 한쪽을
 * 확인하려고 브라우저를 다시 열 때 다른 쪽 세션이 끊긴다. (실제로 겪은 문제다)
 *
 * 아이디와 비밀번호는 이 프로그램이 받지도, 저장하지도 않는다.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CHATGPT_ORIGIN = 'https://chatgpt.com';

/** 로그인됐다는 뜻의 쿠키. 이름이 판마다 조금 달라서 후보를 여러 개 본다. */
const SESSION_COOKIES = [
  '__Secure-next-auth.session-token',
  '__Secure-next-auth.session-token.0',
  '__Session',
];

let context = null;
let contextHeadless = null;

/**
 * 로그인 세션은 persistent context(프로필 폴더)에 그대로 남는다.
 * data/chatgpt-profile 을 지우지 않는 한 재로그인할 필요가 없다.
 */
export async function getChatGptContext({ headless } = {}) {
  const settings = getSettings();
  const wantHeadless = headless ?? Boolean(settings.chatgpt.headless);

  if (context && contextHeadless === wantHeadless) return context;
  if (context) {
    logger.warn(
      `ChatGPT 브라우저를 ${contextHeadless ? '숨김' : '창 보임'} → `
      + `${wantHeadless ? '숨김' : '창 보임'} 모드로 다시 엽니다.`,
    );
    await closeChatGptContext();
  }

  await ensureBrowsers();
  ensureDirs();

  context = await chromium.launchPersistentContext(CHATGPT_PROFILE_DIR, withExecutable({
    headless: wantHeadless,
    viewport: { width: 1440, height: 960 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: UA,
    slowMo: settings.run.slowMoMs || 0,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=ko-KR',
    ],
  }));
  contextHeadless = wantHeadless;

  // 만든 그림을 클립보드로 옮기는 경로가 막히면 안 된다.
  await context
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: CHATGPT_ORIGIN })
    .catch(() => {});

  context.on('close', () => {
    context = null;
    contextHeadless = null;
  });

  if (!(await hasChatGptCookies(context).catch(() => false))) {
    const restored = await restoreCookies(context);
    if (restored) logger.info('저장해둔 ChatGPT 쿠키를 되살렸습니다.');
  }

  return context;
}

export async function closeChatGptContext() {
  if (context) await context.close().catch(() => {});
  context = null;
  contextHeadless = null;
}

export function readChatGptSession() {
  try {
    return JSON.parse(fs.readFileSync(CHATGPT_SESSION_FILE, 'utf8'));
  } catch {
    return { loggedIn: false, plan: '', checkedAt: null };
  }
}

function writeChatGptSession(info) {
  ensureDirs();
  const next = { ...readChatGptSession(), ...info, checkedAt: new Date().toISOString() };
  fs.writeFileSync(CHATGPT_SESSION_FILE, JSON.stringify(next, null, 2), 'utf8');
  push('chatgpt-session', next);
  return next;
}

/** ChatGPT 로그인 쿠키가 살아 있는지 확인. */
export async function hasChatGptCookies(ctx) {
  const cookies = await ctx.cookies(CHATGPT_ORIGIN);
  const names = new Set(cookies.map((cookie) => cookie.name));
  return SESSION_COOKIES.some((name) => names.has(name));
}

/**
 * 쿠키를 파일로 따로 보관한다.
 *
 * 크로미움은 프로필 폴더에 쿠키를 곧바로 쓰지 않는다. 브라우저가 정상적으로
 * 닫혀야 기록되는데, 사용자가 로그인 창을 X 로 닫으면 그 과정이 생략돼
 * 다음에 띄웠을 때 로그인이 풀린 창이 뜬다. 그래서 따로 받아 두었다가
 * 프로필에 없으면 되살린다. (네이버 쪽과 같은 이유다)
 */
async function saveCookies(ctx) {
  try {
    const cookies = await ctx.cookies();
    if (!cookies.length) return false;
    ensureDirs();
    fs.writeFileSync(CHATGPT_STORAGE_FILE, JSON.stringify({ cookies }, null, 2), 'utf8');
    // 로그인 쿠키가 든 파일이다. 같은 컴퓨터의 다른 계정에서 못 읽게 한다.
    try {
      fs.chmodSync(CHATGPT_STORAGE_FILE, 0o600);
    } catch {
      // 윈도우 등 권한 모델이 다른 환경에서는 넘어간다.
    }
    return true;
  } catch (error) {
    logger.warn(`ChatGPT 쿠키를 저장하지 못했습니다: ${error.message}`);
    return false;
  }
}

async function restoreCookies(ctx) {
  if (!fs.existsSync(CHATGPT_STORAGE_FILE)) return false;
  try {
    const { cookies } = JSON.parse(fs.readFileSync(CHATGPT_STORAGE_FILE, 'utf8'));
    if (!Array.isArray(cookies) || !cookies.length) return false;

    const now = Date.now() / 1000;
    const alive = cookies.filter(
      (cookie) => !cookie.expires || cookie.expires < 0 || cookie.expires > now,
    );
    if (!alive.length) return false;

    await ctx.addCookies(alive);
    return true;
  } catch (error) {
    logger.warn(`저장해둔 ChatGPT 쿠키를 되살리지 못했습니다: ${error.message}`);
    return false;
  }
}

/**
 * 어떤 구독인지 화면에서 읽어본다.
 * 못 읽어도 상관없다. 로그인 여부만 확실하면 그림은 만들어진다.
 */
async function detectPlan(page) {
  try {
    const text = await page.evaluate(() => {
      const hit = [...document.querySelectorAll('button, div, span')]
        .map((node) => (node.textContent || '').trim())
        .find((value) => /^(ChatGPT )?(Plus|Pro|Team|Business|Enterprise|Free)$/i.test(value));
      return hit || '';
    });
    return String(text).replace(/^ChatGPT\s+/i, '').trim();
  } catch {
    return '';
  }
}

/** 로그인 화면이 떠 있는지. 떠 있으면 세션이 풀린 것이다. */
export async function looksLoggedOut(page) {
  try {
    const url = page.url();
    if (/\/auth\/login|\/auth\/signin|auth0\.openai\.com|login\.openai\.com/i.test(url)) return true;
    return await page.evaluate(() => {
      const labels = ['로그인', 'Log in', 'Sign up', '회원 가입'];
      const buttons = [...document.querySelectorAll('button, a')]
        .map((node) => (node.textContent || '').trim());
      const hasLogin = buttons.some((text) => labels.includes(text));
      const hasComposer = Boolean(
        document.querySelector('#prompt-textarea, div[contenteditable="true"]'),
      );
      return hasLogin && !hasComposer;
    });
  } catch {
    return false;
  }
}

/** 저장된 세션이 아직 유효한지 확인하고 상태를 갱신한다. */
export async function verifyChatGptSession({ headless } = {}) {
  if (!fs.existsSync(CHATGPT_PROFILE_DIR)) {
    return writeChatGptSession({ loggedIn: false, plan: '' });
  }

  const ctx = await getChatGptContext(headless === undefined ? {} : { headless });
  const page = await ctx.newPage();
  try {
    await page.goto(CHATGPT_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 쿠키는 화면이 뜬 직후 잠깐 비어 보일 수 있다. 한 번 어긋났다고
    // 로그아웃으로 단정하면 그림 생성까지 막히므로 몇 번 더 확인한다.
    let loggedIn = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      loggedIn = await hasChatGptCookies(ctx).catch(() => false);
      if (loggedIn) break;
      await page.waitForTimeout(1500);
    }
    if (!loggedIn || await looksLoggedOut(page)) {
      logger.warn('ChatGPT 로그인 쿠키를 찾지 못했습니다. 다시 로그인해 주세요.');
      return writeChatGptSession({ loggedIn: false });
    }

    const plan = await detectPlan(page);
    await saveCookies(ctx);
    return writeChatGptSession({ loggedIn: true, plan: plan || readChatGptSession().plan || '' });
  } catch (error) {
    // 확인에 실패했다고 멀쩡한 세션을 로그아웃으로 바꾸지 않는다.
    logger.warn(`ChatGPT 세션 확인을 건너뜁니다 (${error.message}). 저장된 상태를 그대로 씁니다.`);
    return readChatGptSession();
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 사용자가 직접 로그인할 수 있게 실제 브라우저 창을 띄운다.
 * 아이디/비밀번호는 프로그램이 다루지 않는다 - 2단계 인증도 그대로 통과한다.
 */
export async function openChatGptLoginWindow({ timeoutMs = 300000 } = {}) {
  await closeChatGptContext();                 // 로그인은 항상 창을 띄워서 한다.
  const ctx = await getChatGptContext({ headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());

  logger.step('ChatGPT 로그인 창을 띄웠습니다. 창에서 구독 계정으로 직접 로그인해 주세요.');
  await page.goto(`${CHATGPT_ORIGIN}/auth/login`, { waitUntil: 'domcontentloaded' })
    .catch(() => page.goto(CHATGPT_ORIGIN, { waitUntil: 'domcontentloaded' }));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    if (await hasChatGptCookies(ctx).catch(() => false)) {
      const plan = await detectPlan(page);
      logger.info(`ChatGPT 로그인 성공${plan ? ` · ${plan}` : ''}. 세션을 저장합니다.`);
      const info = writeChatGptSession({ loggedIn: true, plan });

      // 쿠키를 따로 받아두고 브라우저를 정상적으로 닫는다.
      // 정상 종료를 해야 프로필 폴더에도 쿠키가 기록된다.
      await saveCookies(ctx);
      await page.close().catch(() => {});
      await closeChatGptContext();
      logger.info('ChatGPT 로그인 정보를 저장하고 창을 닫았습니다.');
      return info;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.warn('ChatGPT 로그인이 완료되지 않았습니다 (시간 초과 또는 창 닫힘).');
  return writeChatGptSession({ loggedIn: false });
}

/** 저장된 ChatGPT 로그인 세션을 지운다. */
export async function chatGptLogout() {
  await closeChatGptContext();
  fs.rmSync(CHATGPT_PROFILE_DIR, { recursive: true, force: true });
  fs.rmSync(CHATGPT_SESSION_FILE, { force: true });
  fs.rmSync(CHATGPT_STORAGE_FILE, { force: true });
  logger.info('저장된 ChatGPT 세션을 삭제했습니다.');
  return push('chatgpt-session', { loggedIn: false, plan: '' });
}
