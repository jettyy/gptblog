/**
 * 썸네일 그림 받아오기 점검 (npm run check:image).
 *
 * `npm run check` 는 브라우저를 안 띄우고, `check:bulk` 는 대시보드만 본다.
 * 그림을 실제로 받아오는 길(chatgpt.com 대화창 몰기)은 아무도 검사하지 않았다.
 *
 * 이 파일이 생긴 이유:
 *   대화창을 **임시 채팅**으로 열고 있었다. 임시 채팅에서는 이미지 생성이
 *   막혀 있어서, 그려 달라고 하면 그림 대신
 *     "여기서는 이미지를 생성할 수 없습니다. 일반 채팅창을 이용해 주세요"
 *   라는 글만 돌아왔다. 100편을 돌려도 썸네일이 한 장도 안 나왔다.
 *   대화 기록을 안 남기려고 켜 둔 설정이 그림을 통째로 막고 있었던 것이다.
 *
 * 진짜 계정에는 접속하지 않는다. chatgpt.com 을 흉내낸 **가짜 페이지**를 띄우고
 * CHATGPT_ORIGIN 으로 그쪽을 보게 한 뒤, 임시 채팅으로 열렸는지 일반 채팅으로
 * 열렸는지에 따라 다르게 답하게 해서 우리 코드가 어느 쪽으로 여는지 확인한다.
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.IMAGE_CHECK_PORT || 4111);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// 점검용 주소를 먼저 심어야 세션 모듈이 그것을 읽는다.
process.env.CHATGPT_ORIGIN = ORIGIN;

const { CHATGPT_SESSION_FILE, CHATGPT_STORAGE_FILE, ensureDirs } = await import('../src/lib/paths.js');
const { saveSettings, getSettings, DEFAULT_SETTINGS } = await import('../src/lib/settings.js');

/** 1x1 투명 PNG. 그림이 실제로 내려받아지는지만 보면 된다. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gFvsQ8AAAAASUVORK5CYII=',
  'base64',
);

/**
 * 가짜 페이지의 동작을 바꾸는 손잡이.
 *
 *   normal    — 일반 채팅으로 열리면 그림을 만든다 (진짜와 같은 동작)
 *   stubborn  — 어떻게 열어도 거절문만 답한다 (계정 설정이 임시 채팅을 강제하는 상황)
 */
let mode = 'normal';

/**
 * chatgpt.com 을 흉내낸 최소 페이지.
 *
 * 핵심은 이것이다. **임시 채팅으로 열리면 그림을 만들지 않고 거절문을 답한다.**
 * 진짜 ChatGPT 가 그렇게 동작하기 때문이다.
 */
function fakeChatGpt() {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/img.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(PNG);
      return;
    }

    const temporary = mode === 'stubborn' || /temporary-chat=true/.test(req.url);
    /*
     * 캐시를 막아야 한다. 주소가 같아서, 캐시를 허용하면 크로미움이 앞 검사에서
     * 받아둔 페이지를 그대로 꺼내 쓴다. 그러면 동작을 바꿔도 검사가 안 바뀐다.
     * (실제로 이것 때문에 검사 하나가 엉뚱하게 통과했다)
     */
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
    });
    res.end(`<!doctype html><meta charset="utf-8"><body>
<div id="opened-url" data-url="${req.url.replace(/"/g, '&quot;')}"></div>
<div id="prompt-textarea" contenteditable="true"></div>
<button data-testid="send-button">보내기</button>
<div id="turns"></div>
<script>
const TEMPORARY = ${temporary};
document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
  const stop = document.createElement('button');
  stop.setAttribute('data-testid', 'stop-button');
  stop.textContent = '중지';
  document.body.appendChild(stop);
  setTimeout(() => {
    stop.remove();
    const turn = document.createElement('div');
    turn.setAttribute('data-message-author-role', 'assistant');
    if (TEMPORARY) {
      turn.textContent = '임시 채팅에서는 이미지를 생성할 수 없습니다. '
        + '이미지를 생성하고 싶으면 일반 채팅창을 이용해 주세요.';
    } else {
      turn.innerHTML = '<p>그림을 만들었습니다.</p><img src="/img.png?generated=1">';
    }
    document.getElementById('turns').appendChild(turn);
  }, 800);
});
</script></body>`);
  });
}

/** 로그인된 것처럼 보이게 세션 파일과 쿠키를 심는다. */
function seedSession() {
  ensureDirs();
  fs.writeFileSync(
    CHATGPT_SESSION_FILE,
    JSON.stringify({ loggedIn: true, plan: 'Plus', checkedAt: new Date().toISOString() }),
    'utf8',
  );
  // __Secure- 접두사는 https 에서만 붙일 수 있어서, 점검에는 __Session 을 쓴다.
  fs.writeFileSync(CHATGPT_STORAGE_FILE, JSON.stringify({
    cookies: [{
      name: '__Session',
      value: 'check',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    }],
  }), 'utf8');
}

let failures = 0;
function check(ok, name, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

console.log('썸네일 그림 받아오는 길을 가짜 chatgpt.com 으로 점검합니다.\n');

seedSession();
const before = getSettings().chatgpt.temporaryChat;
// 글쓰기 쪽 설정은 **켜 둔 채로** 점검한다. 그래야 "그림이 이 설정에
// 휘둘리지 않는지" 를 보게 된다. 예전에는 이 설정이 그림까지 끌고 갔다.
saveSettings({ chatgpt: { temporaryChat: true, headless: true, webModel: 'gpt-5-1-thinking' } });

const server = fakeChatGpt();
await new Promise((resolve) => server.listen(PORT, resolve));

const { generateImageWeb, askChatGptWeb } = await import('../src/ai/webchat.js');
const { closeChatGptContext } = await import('../src/ai/session.js');

try {
  /* ---------- 그림: 일반 채팅으로 열려야 한다 ---------- */
  let image = null;
  let failure = '';
  try {
    image = await generateImageWeb('a bright classroom illustration', { aspectRatio: '16:9' });
  } catch (error) {
    failure = error.message;
  }

  check(
    Boolean(image?.dataUri),
    '임시 채팅 설정이 켜져 있어도 그림이 만들어진다',
    failure || `${Math.round((image?.bytes || 0))}바이트`,
  );
  check(
    String(image?.dataUri || '').startsWith('data:image/png;base64,'),
    '만든 그림을 실제로 내려받아 data URI 로 돌려준다',
    String(image?.dataUri || '').slice(0, 40),
  );

  /* ---------- 글쓰기: 임시 채팅을 그대로 쓴다 ---------- */
  const reply = await askChatGptWeb('아무 질문', { timeoutMs: 60000 }).catch((error) => ({
    text: `실패: ${error.message}`,
  }));
  check(
    /임시 채팅/.test(reply.text),
    '글쓰기는 설정대로 임시 채팅으로 연다 (대화 기록을 안 남기려는 설정이 살아 있다)',
    String(reply.text).slice(0, 80),
  );

  /* ---------- 계정 설정이 임시 채팅을 강제하는 경우 ---------- */
  // 어떻게 열어도 거절문만 오게 만들어, 사람이 원인을 알 수 있는 메시지가
  // 나가는지 본다. 이때 "한도 초과" 같은 엉뚱한 안내가 나가면 원인을 못 찾는다.
  mode = 'stubborn';

  let message = '';
  try {
    await generateImageWeb('a classroom', { aspectRatio: '16:9', timeoutMs: 60000 });
    message = '(실패해야 하는데 성공했습니다)';
  } catch (error) {
    message = error.message;
  }
  check(
    /임시 채팅/.test(message) && /끄고/.test(message),
    '그래도 거절당하면 무엇을 손봐야 하는지 알려준다',
    message.slice(0, 170),
  );
  check(
    !/한도/.test(message),
    '원인이 분명한 실패를 "한도 초과" 로 뭉개지 않는다',
    message.slice(0, 120),
  );
  mode = 'normal';
} finally {
  await closeChatGptContext().catch(() => {});
  server.close();
  saveSettings({
    chatgpt: {
      temporaryChat: before,
      headless: DEFAULT_SETTINGS.chatgpt.headless,
      webModel: DEFAULT_SETTINGS.chatgpt.webModel,
    },
  });
  fs.rmSync(CHATGPT_SESSION_FILE, { force: true });
  fs.rmSync(CHATGPT_STORAGE_FILE, { force: true });
}

console.log(failures ? `\n실패 ${failures}건` : '\n모두 통과했습니다.');
process.exit(failures ? 1 : 0);
